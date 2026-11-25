/**
 * vm.mjs —— 虚拟机（远端 Linux）的唯一放行口
 *
 * 和 exec-guard.mjs 的分工：
 *   - exec-guard 管**本机进程**：只接受「可执行文件 + 参数数组」，没有 shell 参与，
 *     所以 `;` `&&` `|` `$()` 在结构上就无效。
 *   - vm.mjs 管**另一台机器**：sshd 那一端一定会起 shell，命令本质就是一段文本，
 *     没法用参数数组消除拼接。所以改成两道文本闸：
 *       1) `looksBroken()`：半截命令（引号不配对、结尾停在 | && \、heredoc 没闭合）、
 *          通篇中文描述、自己套了一层 base64 —— 这些交给 bash 只会变成噪音，退回让她重写。
 *       2) `dangerReason()`：破坏性删除、格式化、写裸设备、关机、提权、改账户、
 *          下载即执行、反弹 shell、改防火墙/内核 —— 命中即拒，不看别的。
 *
 * 为什么 base64：命令里有引号、换行、中文时，直接塞进 ssh 的 argv 会被远端 shell
 * 拆坏（引号在本地就被 ssh 的拼接吃掉一层）。编码成单行传过去再解码执行，内容原样落地。
 *
 * 这东西本身不判权限：调用方必须先 requireGrant('vm')，默认一项权限都不给。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** 虚拟机默认怎么连（VirtualBox NAT 转发：宿主 127.0.0.1:2222 → 客户机 22） */
export const VM_DEFAULT = { host: '127.0.0.1', port: 2222, user: 'aurelia' };

/** 命令最大长度：base64 之后还要留余量，argv 太长会被系统和 sshd 拒 */
export const VM_MAX_CMD = 4000;

/**
 * 危险命令：命中即拒。
 * 这是兜底，不是主要防线——主要防线是「默认没授权，开了授权也只跑她自己想出来的非破坏性命令」。
 */
const DANGEROUS = [
  // 破坏性删除 / 格式化 / 写裸设备
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, why: '递归或强制删除' },
  { re: /\bmkfs(\.\w+)?\b/, why: '格式化文件系统' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, why: '写裸设备' },
  { re: /\b(shred|wipefs)\b/, why: '擦除数据' },
  { re: />\s*\/dev\/(sd|nvme|hd|vd)/, why: '重定向到磁盘设备' },
  // 关机 / 重启 / 杀全局进程
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: '关机或重启' },
  { re: /\binit\s+[06]\b/, why: '切换运行级别' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall5\b/, why: '杀全部进程' },
  // 权限 / 属主
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\//, why: '把根目录改成 777' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*[ugoa]*\+s\b/, why: '设置 setuid/setgid' },
  { re: /\bchown\s+(-[a-zA-Z]+\s+)*[^ ]+\s+\/\s*$/, why: '改根目录属主' },
  // 提权 / 改账户
  { re: /\b(sudo|su|doas)\s/, why: '提权' },
  { re: /\b(useradd|userdel|usermod|groupadd|groupdel|passwd)\b/, why: '改账户' },
  // 下载即执行 / 管道进 shell
  { re: /\b(curl|wget|fetch)\b[^|;]*\|\s*(ba|z|d|k)?sh\b/, why: '下载后直接执行' },
  { re: /\|\s*(ba|z|d|k)?sh\s*($|;)/, why: '管道进 shell' },
  { re: /\beval\s+/, why: 'eval 动态执行' },
  // fork 炸弹 / 反弹 shell / 裸网络连接
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: /\bnc\b[^|;]*\s-e\s/, why: '反弹 shell' },
  { re: /\/dev\/tcp\//, why: 'bash 直接开网络连接' },
  // 防火墙 / 内核 / 计划任务
  { re: /\b(iptables|nft|ufw|firewall-cmd)\b/, why: '改防火墙' },
  { re: /\b(sysctl|insmod|rmmod|modprobe)\b/, why: '改内核参数或模块' },
  { re: /\bcrontab\s+-r\b/, why: '清空计划任务' },
  // 从这台机器再连出去（跳板）
  { re: /\b(ssh|scp|sftp|rsync)\b[^|;]*@/, why: '连远端主机' },
];

/** 命中危险命令就返回原因，否则空串 */
export function dangerReason(cmd) {
  const s = String(cmd || '');
  for (const d of DANGEROUS) {
    if (d.re.test(s)) return d.why;
  }
  return '';
}

/**
 * 命令看起来没写完：引号不配对、结尾停在 | && || \ 、heredoc 没闭合、
 * 或者压根不是命令（只有中文描述）、或者她自己多套了一层 base64。
 * 这类「半截命令」交给 bash 只会变成乱七八糟的报错，不如直接退回让她重写。
 */
export function looksBroken(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return '空命令';
  const sq = (s.match(/'/g) || []).length;
  const dq = (s.match(/"/g) || []).length;
  if (sq % 2 === 1) return '单引号没闭合（命令写到一半断了）';
  if (dq % 2 === 1) return '双引号没闭合（命令写到一半断了）';
  if (/(\|\||&&|\||>|>>|=|\\)$/.test(s)) return '命令结尾停在 ' + s.slice(-2) + '（没写完）';
  const hd = s.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
  if (hd) {
    const tag = hd[1];
    const lines = s.split('\n').map((x) => x.trim());
    if (!lines.includes(tag)) return `heredoc ${tag} 没有闭合`;
  }
  if (/[\u4e00-\u9fa5]/.test(s) && !/[;&|><=$`]/.test(s)) {
    return '这写的是一句描述，不是能执行的命令';
  }
  if (/printf\s+%s\s+[A-Za-z0-9+/=]{20,}/.test(s)) {
    return '不用自己套 base64，直接写要跑的命令就行';
  }
  return '';
}

/** 把一段（可能多行的）命令编成一行远端可执行的 shell 片段 */
export function wrapRemote(cmd) {
  const b64 = Buffer.from(String(cmd), 'utf8').toString('base64');
  return `printf %s ${b64} | base64 -d | bash`;
}

/**
 * 拼 ssh 的 argv。
 *
 * BatchMode=yes + NumberOfPasswordPrompts=0 是硬要求：不然公钥一不对，ssh 会退到
 * 「请输入密码」，而调用方的 stdin 是个永远不关的管道 → 进程挂到超时被杀 →
 * 拿到的错误只剩一句 Command failed，真正的 Permission denied 被吞掉。
 */
export function buildSshArgs(cfg, remote) {
  const host = String((cfg && cfg.host) || VM_DEFAULT.host);
  const port = Number((cfg && cfg.port) || VM_DEFAULT.port) || VM_DEFAULT.port;
  const user = String((cfg && cfg.user) || VM_DEFAULT.user);
  const args = [
    '-p', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'ConnectTimeout=8',
  ];
  const keyFile = String((cfg && cfg.keyFile) || '').trim();
  if (keyFile) args.push('-i', keyFile);
  args.push(`${user}@${host}`);
  // 远端命令作为最后一个参数：base64 之后只含 A-Z a-z 0-9 + / = 和空格，不会被本地拆
  args.push(String(remote || 'true'));
  return args;
}

/** 只测 TCP 通不通，不登入、不握手 */
export function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        if (sock) sock.destroy();
      } catch (error) {}
      resolve(ok);
    };
    try {
      sock = net.connect({ host, port: Number(port) });
    } catch (error) {
      return finish(false);
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * 私钥在哪：设置里给的最优先，其次按常见位置找。
 * DSH 换安装位置后 home 会变，写死一条路径就会全线连不上。
 */
export function resolveKeyFile(settings, homeDir) {
  const home = homeDir || os.homedir();
  const cands = [
    String((settings && settings.vmSshKey) || '').trim(),
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.ssh', 'id_rsa'),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (error) {}
  }
  return cands[0] || '';
}

/**
 * 送进 ssh 之前的最后一道：形状校验。
 * 远端那一端一定会起 shell，所以这里不假装能「结构上消除拼接」，
 * 而是确认 argv 就是我们要的那几条开关 + 一个 base64 包装过的命令。
 */
export function checkVmExec(argv) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('vm: argv 为空');
  const remote = String(argv[argv.length - 1] || '');
  if (!/^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| bash$/.test(remote)) {
    throw new Error('vm: 远端命令必须是 base64 包装后的形态');
  }
  if (!argv.includes('BatchMode=yes')) throw new Error('vm: 必须带 BatchMode=yes');
  if (argv.includes('-o') && argv.includes('PasswordAuthentication=yes')) {
    throw new Error('vm: 不允许退回密码认证');
  }
  return true;
}
