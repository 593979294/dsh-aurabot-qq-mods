// 她拿主意的那一层：上班是干活还是摸鱼、放假是出门还是在家、手上的活和出门的去处。
// 这里只算「决定了什么、后果有多大」，不发送、不注入、不动别人的模块——
// 那些由 index.mjs 按分享概率和心情去接。全部纯函数，rand 可注入，测试直接跑。
const MIN = 60 * 1000
const HOUR = 60 * MIN

// 上班时手头可能有的活：按职业给池子，抽一条就算今天这件事
export const WORK_TASKS = {
  office: ['把季度报表第三页的数据核对完', '整理下周例会的会议纪要', '给供应商回三封邮件', '把报销单录进系统', '重排一遍会议室预订表', '把档案柜里的合同归档'],
  programmer: ['修掉那个偶发的登录超时', '把接口文档补完', '过一遍同事提的代码评审意见', '把单测覆盖率往上拉一截', '重构那段谁都不敢动的分页逻辑', '排查线上那条慢查询'],
  teacher: ['改完两个班的作文', '备明天上午的两节课', '出一套随堂小测', '把这次月考的成绩录进系统', '找两个学生单独聊一聊', '整理下周的教学进度'],
  doctor: ['写完上午门诊的记录', '把三份化验单看完', '跟着主任查一遍房', '补完病程记录', '给两个复诊的病人回电话'],
  nurse: ['核对三床的用药单', '写交接班记录', '给两床换输液', '量完整个病区的体温', '清点一遍备用药', '整理治疗车'],
  restaurant: ['备好午市的凉菜', '把大厅的桌子擦一遍', '清点酒水库存', '帮后厨搬一趟货', '记一遍明天的订位'],
  sales: ['接待三波来看车的客人', '把展车擦一遍', '回访上周留电话的客户', '盘一遍库存款式', '整理这个月的成交单'],
  courier: ['跑完午高峰那十二单', '给电瓶换组电池', '处理两个超时单的申诉', '把保温箱刷一遍'],
  security: ['把小区巡两遍', '登记来访车辆', '盯一会儿监控', '检查消防通道有没有堆东西', '跟换班的同事交接'],
  factory: ['做完今天的定额', '检查一遍机器', '清理工位', '记录这一批的良品率'],
  student: ['写完物理卷子最后两道大题', '背三十个单词', '整理错题本', '把数学作业交了', '复习明天的测验', '把化学笔记补完'],
}

// 上班摸鱼能摸成什么样
export const SLACKS = ['躲在茶水间刷了会儿手机', '趴在工位上眯了十分钟', '跟同事在走廊上聊了几句', '蹲在厕所里刷视频', '假装在看文件，其实在发呆', '下楼买了杯咖啡，慢慢走了一圈']

// 放假出门的去处：都在「能出门、当天回得来」的范围里
export const OUTINGS = ['去商场逛了一圈', '去公园走了走', '找了家咖啡馆坐了一下午', '去看了场电影', '去超市买了点菜', '去书店翻了会儿书', '沿着河边骑了一圈车', '约朋友吃了个饭', '去菜市场转了一圈']

// 谁管她：摸鱼被抓时说话的是这个人
const LEADER = { office: '主管', programmer: '组长', teacher: '年级主任', doctor: '主任', nurse: '护士长', restaurant: '店长', sales: '店长', courier: '站长', security: '队长', factory: '班长', student: '班主任' }
// 管得严的职业：被抓概率更高
const STRICT = new Set(['teacher', 'doctor', 'nurse', 'restaurant', 'security', 'factory', 'courier'])

export const leaderOf = (id) => LEADER[id] || '主管'
export const caughtChance = (id) => (STRICT.has(id) ? 0.2 : 0.08)
export const tasksFor = (id) => WORK_TASKS[id] || WORK_TASKS.office

export const pick = (list, rand = Math.random) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))]
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const minsOf = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes() }

// 一条活：多久要做完、做完算多少进度
export function newTask(profId, now, { rand = Math.random, hours = 3 } = {}) {
  const h = clamp(hours * (0.7 + rand() * 0.6), 0.5, 12)
  return {
    id: `t${now}${Math.floor(rand() * 1000)}`,
    title: pick(tasksFor(profId), rand),
    at: now,
    deadline: now + Math.round(h * HOUR),
    progress: 0,
    done: false,
    failed: false,
  }
}

// 干一次活推进多少：25%~45%，两次到三次能干完
export function advance(task, rand = Math.random) {
  const gain = 25 + Math.floor(rand() * 21)
  task.progress = Math.min(100, task.progress + gain)
  return task.progress >= 100
}

// 这次是干活还是摸鱼。心情差、压力大更想摸；手上有活儿卡着点就不敢摸。
export function willSlack({ mood = 60, pressure = 0, urgent = false, now = Date.now() } = {}, rand = Math.random) {
  const mins = minsOf(now)
  let p = 0.22
  if (mood < 45) p += 0.12
  if (mood < 35) p += 0.08
  if (pressure >= 60) p += 0.08
  if (urgent) p -= 0.2
  if (mins >= 13 * 60 && mins < 14 * 60 + 30) p += 0.08 // 午饭后最容易走神
  if (mins >= 17 * 60 && mins < 18 * 60) p += 0.06 // 临近收工
  return rand() < clamp(p, 0.04, 0.65)
}

// 休息日要不要出门。心情好、白天更愿意出去；压力大、太早太晚更想窝着。
export function willGoOut({ mood = 60, pressure = 0, now = Date.now() } = {}, rand = Math.random) {
  const mins = minsOf(now)
  let p = 0.45
  if (mood >= 65) p += 0.12
  if (mood < 40) p -= 0.15
  if (pressure >= 65) p -= 0.12
  if (mins < 9 * 60) p -= 0.15
  if (mins >= 20 * 60) p -= 0.22
  return rand() < clamp(p, 0.08, 0.75)
}

export function newOuting(now, { rand = Math.random } = {}) {
  const hours = 1 + rand() * 2.5
  return { act: pick(OUTINGS, rand), from: now, until: now + Math.round(hours * HOUR) }
}

// ---------- 各个决定的说法和后果（面板看 text，发给她主人用 say）----------
export function doWork({ task, rand = Math.random } = {}) {
  if (!task) {
    return { kind: 'work', text: '把手头的活收了收，没什么非做不可的', say: '活不多，慢慢收尾呢', mood: 1, shareable: true }
  }
  const done = advance(task, rand)
  return done
    ? { kind: 'task-done', taskId: task.id, text: `把「${task.title}」做完了`, say: `「${task.title}」终于弄完了`, mood: 5, shareable: true, memory: true }
    : { kind: 'work', taskId: task.id, text: `接着做「${task.title}」，到 ${task.progress}%`, say: `还在跟「${task.title}」较劲`, mood: 1, shareable: true }
}

export function doSlack({ profId = 'office', rand = Math.random } = {}) {
  const caught = rand() < caughtChance(profId)
  if (caught) {
    const who = leaderOf(profId)
    return { kind: 'slack-caught', text: `摸鱼被${who}看见了，说了两句`, say: `刚偷懒被${who}撞见了…`, mood: -6, shareable: true, memory: true }
  }
  return { kind: 'slack', text: pick(SLACKS, rand), say: pick(SLACKS, rand), mood: 2, shareable: true }
}

export function goOut({ outing }) {
  return { kind: 'out', outing, text: `出门了，${outing.act}`, say: `出来${outing.act.replace(/^去/, '')}`, mood: 2, shareable: true }
}

export function backHome({ outing }) {
  return { kind: 'out-back', outgoing: outing, text: `${outing.act}，回来了`, say: `回来了，${outing.act.replace(/^去/, '')}`, mood: 3, shareable: true, memory: true }
}

export function stayHome({ now = Date.now() } = {}) {
  const h = new Date(now).getHours()
  const late = h >= 20
  return { kind: 'home', text: late ? '今天不出去了，晚上在家待着' : '今天不出门，在家待着', say: '今天不出去啦，在家', mood: 0, shareable: true }
}

export function taskFailed({ task, profId = 'office' }) {
  const who = leaderOf(profId)
  return { kind: 'task-failed', taskId: task.id, text: `「${task.title}」没按时做完，被${who}说了一顿`, say: `「${task.title}」拖过头了，被${who}说了`, mood: -8, shareable: true, memory: true }
}
