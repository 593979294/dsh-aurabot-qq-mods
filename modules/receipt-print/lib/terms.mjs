// 使用协议：必须在确认后才能打印。
// 条款有实质改动时提升 TERMS_VERSION，已确认过的用户会被要求重新确认。
export const TERMS_VERSION = '1.0'
export const TERMS_TITLE = '热敏打印使用协议'

export const TERMS_ITEMS = [
  '仅在你自有或已获授权的打印机和账号上使用，不得用于伪造票据、凭证或侵害他人权益。',
  '说说自动打印和定时任务会在无人值守时出纸，请自行确认打印内容；公共或共享环境中建议关闭自动打印。',
  '模板生成会通过宿主把提示词发给你配置的模型服务；图片在本机处理，但会按其原始地址下载。',
  '打印备份包含正文并保存在本机，请自行管理目录权限和清理；模块不向作者上传任何数据。',
  '本模块按现状提供，不对错打、漏打、耗材浪费、设备损坏或内容泄露承担责任。',
  '继续使用即表示你已阅读并同意以上条款；条款更新后需要重新确认。',
]

export function termsAccepted(settings = {}) {
  return String(settings?.termsVersion || '') === TERMS_VERSION
}

export function termsPublic(settings = {}) {
  return {
    version: TERMS_VERSION,
    title: TERMS_TITLE,
    items: TERMS_ITEMS,
    accepted: termsAccepted(settings),
    acceptedVersion: String(settings?.termsVersion || ''),
  }
}

export function termsText() {
  return [
    `《${TERMS_TITLE}》v${TERMS_VERSION}`,
    '',
    ...TERMS_ITEMS.map((item, index) => `${index + 1}. ${item}`),
    '',
    '确认：/小票 同意',
  ].join('\n')
}

export function termsGate(settings = {}) {
  if (termsAccepted(settings)) return ''
  return `使用前需要先同意《${TERMS_TITLE}》v${TERMS_VERSION}。\n发 /小票 协议 查看全文，再发 /小票 同意 确认。`
}
