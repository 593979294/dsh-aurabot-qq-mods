// 定时任务的纯判断：什么时候抓、什么时候发、什么时候放弃。
import { isHm } from './time.mjs'

export const RETRY_INTERVAL_MS = 30 * 60 * 1000
const CHAT = /^(private|group):[1-9]\d*$/

export function initialState(stamp, settings) {
  const time = String(settings?.time || '')
  return {
    date: stamp.date,
    attempts: 0,
    lastAttempt: 0,
    sent: [],
    completed: '',
    noUpdate: '',
    // 首次安装如果已经过了开始时间，今天不再补发，从明天开始。
    firstSkip: isHm(time) && stamp.time >= time ? stamp.date : '',
    title: '',
    source: '',
  }
}

/**
 * 返回 { action, reason }。
 * action：skip 什么都不做；error 配置不合法；giveup 截止后仍没有图；
 * fetch 去找今天的文章；deliver 图已经在缓存里，只补发没送到的聊天。
 */
export function decideTick({ stamp, settings, state, enabled, dryRun, busy, nowMs, hasImage }) {
  if (busy) return { action: 'skip', reason: 'busy' }
  if (settings?.daily === false) return { action: 'skip', reason: 'daily-off' }
  if (!enabled || dryRun) return { action: 'skip', reason: 'paused' }
  if (!isHm(settings?.time) || !isHm(settings?.deadline)) return { action: 'error', reason: '时间格式必须是 HH:mm' }
  if (settings.deadline <= settings.time) return { action: 'error', reason: '截止时间要晚于开始时间' }
  if (stamp.time < settings.time) return { action: 'skip', reason: 'before-time' }
  if (state?.completed === stamp.date || state?.noUpdate === stamp.date || state?.firstSkip === stamp.date) {
    return { action: 'skip', reason: 'settled' }
  }
  const sameDay = state?.date === stamp.date
  const attempted = sameDay && (state?.attempts || 0) > 0
  // 截止后不再为「还没下到图」重试。已经下到的图继续补发，不受截止时间限制。
  if (!hasImage && stamp.time >= settings.deadline && attempted) return { action: 'giveup', reason: 'deadline' }
  const waited = !attempted || nowMs - (state?.lastAttempt || 0) >= RETRY_INTERVAL_MS
  if (!waited) return { action: 'skip', reason: 'retry-wait' }
  if (hasImage) return { action: 'deliver' }
  return { action: 'fetch' }
}

/** 留空则发给主人。一行一个 private:QQ号 或 group:群号。 */
export function parseTargets(raw, ownerQQ) {
  const text = String(raw ?? '').trim() || `private:${ownerQQ || ''}`
  const chats = [...new Set(text.split(/[\s,，]+/).filter(Boolean))]
  if (!chats.length || chats.some(chat => !CHAT.test(chat))) {
    throw new Error('接收聊天格式应为 private:QQ号 或 group:群号；也可留空发给主人')
  }
  return chats
}
