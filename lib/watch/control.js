// judge 值守 —— 全局控制面接入（stop / takeover / pause）
//
// Hard rule: never build a second stop mechanism.
// judge 只读 ui-control 的状态文件（`ui-control/state.json`），
// 用与 ui_app / ui_browser 完全相同的闸门口径决定自己能不能写：
//
//   IDLE / AGENT_CONTROL  → 放行
//   HUMAN_CONTROL         → 人工接管：只读允许，**新的发送一律拒绝**
//   PAUSED                → 暂停：同样拒绝写
//   STOPPED / emergency   → 紧急停止：判断、发送、重试全部停止
//
// 读不到控制文件时按 IDLE 处理（ui-control 未安装/未初始化）——这与 ui-control 自己的
// 空状态语义一致，且不会把「没装闸门」误判成「已停止」而让值守永远不动。

import { join } from 'node:path'
import { uiControlDir } from './paths.js'
import { readJson } from './store.js'

/** 控制状态文件（**每次取值**：运行目录可被测试/运维切换）。 */
export function controlFile() { return join(uiControlDir(), 'state.json') }

/** 允许写操作的控制状态（与 ui-control 的 WRITE_ALLOWED_STATES 保持一致）。 */
const WRITE_ALLOWED = new Set(['IDLE', 'AGENT_CONTROL'])

/**
 * 读全局控制状态（**每次现读**，不加缓存）。
 *
 * 为什么不做缓存：stop 是人的紧急刹车，晚 200ms 生效也可能是「又发出去一条」的差别；
 * 文件只有几 KB，扫描频率（每个会话每次扫描一次）根本构不成压力。
 */
export function readGlobalControl() {
  const raw = readJson(controlFile(), null)
  if (!raw || typeof raw !== 'object') {
    return { state: 'IDLE', emergency: false, note: '', readAt: new Date().toISOString(), present: false }
  }
  return {
    state: String(raw.state ?? 'IDLE'),
    emergency: raw.emergency?.active === true,
    note: String(raw.emergency?.reason || raw.note || ''),
    owner: raw.owner ?? null,
    revision: raw.revision ?? null,
    readAt: new Date().toISOString(),
    present: true,
  }
}

/**
 * 写操作闸门：判断**能不能发送 / 重试 / 代答**。
 *
 * @returns `{ allowed, phase, reason, control }`。
 *   · allowed=false 时 phase 取 `global-stop` / `global-takeover`（与状态机同名）；
 *   · reason 是给人看的原因码，界面用 machine.reasonText 翻中文。
 */
export function globalGate() {
  const control = readGlobalControl()
  if (control.emergency) {
    return { allowed: false, phase: 'global-stop', reason: 'global-stop', control }
  }
  if (control.state === 'STOPPED') {
    return { allowed: false, phase: 'global-stop', reason: 'global-stop', control }
  }
  if (control.state === 'HUMAN_CONTROL') {
    return { allowed: false, phase: 'global-takeover', reason: 'global-takeover', control }
  }
  if (control.state === 'PAUSED') {
    return { allowed: false, phase: 'global-takeover', reason: 'global-paused', control }
  }
  if (!WRITE_ALLOWED.has(control.state)) {
    // 未知状态一律当「不允许写」：状态机出现新名字时，宁可停手也不要误发。
    return { allowed: false, phase: 'global-stop', reason: 'global-stop', control }
  }
  return { allowed: true, phase: null, reason: null, control }
}

/** 只读是否允许（当前恒为真；留成函数是为了让「读不受闸门限制」变成可断言的事实）。 */
export function readAllowed() {
  return true
}
