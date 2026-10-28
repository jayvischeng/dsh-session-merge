/**
 * dsh-session-merge — merge several existing DSH sessions into one new session.
 *
 * Host half. Exposes two HTTP routes on the web server:
 *
 *   GET  /dsh-session-merge/list      -> { ok, sessions: [{id, version, cwd,
 *                                          createdAt, isSeeded, sizeBytes}] }
 *   POST /dsh-session-merge/merge     -> { ok, sessionId, eventCount, sources }
 *                                          body: { sessionIds: string[],
 *                                                  title?: string,
 *                                                  cwd?: string }
 *
 * Merge semantics ("true merge", option A):
 *   - every source session's full event stream is read via the host
 *     sessionPersistence service (no manual zstd handling);
 *   - the per-session `session` header event is dropped (the new session gets a
 *     fresh header);
 *   - source event streams are concatenated in the order given, each source's
 *     `seq` is shifted by the running offset so the merged stream stays
 *     continuous (0, 1, 2, …);
 *   - intra-session seq references are shifted together: `sourceEventSeqs` on
 *     tool/result events and `surfaceOp.startSeq/endSeq` (V4 spelling) or
 *     `start/end` (legacy spelling) on replace ops;
 *   - `time`/`turn`/`step` payload values are preserved as-is (they are display
 *     hints; the event stream itself is ordered by seq).
 *
 * The new session is created through sessionPersistence.create() (or
 * readFrom/open read handle), so it is a real DSH session with a standard
 * session.v4.jsonl(.zstd) log; the client UI must be refreshed (or the app
 * restarted) for it to appear in the session list, because
 * sessionPersistence.create() persists without announcing a live session.
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

export const name = 'dsh-session-merge'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness')

/** webServer is required: both routes live there. */
export const inject = ['webServer']

/** Header fields the host accepts on create (unknown keys are rejected). */
const HEADER_FIELDS = [
  'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth',
  'cwd', 'parentSession', 'origin', 'agentPreset',
]

function sendJson(res, code, body) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Merge helper: shift a seq reference by `offset`. */
function shiftSeq(v, offset) {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v + offset : v
}

/**
 * Concatenate source event arrays into one continuous stream.
 * @param {Array<{id: string, events: object[]}>} groups
 * @returns {{events: object[], offsetOf: Map<string, number>}}
 */
export function mergeEvents(groups) {
  const out = []
  const offsetOf = new Map()
  let offset = 0
  for (const g of groups) {
    offsetOf.set(g.id, offset)
    let lastSeq = -1
    for (const ev of g.events) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'session') continue // the per-session header event: replaced by the fresh header
      const copy = JSON.parse(JSON.stringify(ev))
      const hasSeq = typeof copy.seq === 'number' && Number.isSafeInteger(copy.seq)
      if (hasSeq) {
        lastSeq = Math.max(lastSeq, copy.seq)
        copy.seq = copy.seq + offset
      }
      // tool/result -> source tool/call seqs
      if (Array.isArray(copy.sourceEventSeqs)) {
        copy.sourceEventSeqs = copy.sourceEventSeqs.map((s) => shiftSeq(s, offset))
      }
      // replace ops (V4 spelling startSeq/endSeq; legacy spelling start/end)
      if (copy.surfaceOp && typeof copy.surfaceOp === 'object') {
        if (Number.isSafeInteger(copy.surfaceOp.startSeq)) copy.surfaceOp.startSeq += offset
        if (Number.isSafeInteger(copy.surfaceOp.endSeq)) copy.surfaceOp.endSeq += offset
        if (Number.isSafeInteger(copy.surfaceOp.start)) copy.surfaceOp.start += offset
        if (Number.isSafeInteger(copy.surfaceOp.end)) copy.surfaceOp.end += offset
      }
      // some producers nest seq references inside data (e.g. tool/call ids are
      // strings, not seqs; message ids are strings) — nothing else to shift here.
      out.push(copy)
    }
    // next source starts after the longest seq seen in this one
    offset += lastSeq + 1
  }
  return { events: out, offsetOf }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return // web server not up yet: nothing to register

  const persistence = () => ctx.get('sessionPersistence')

  async function listSessions() {
    const sp = persistence()
    if (!sp || typeof sp.list !== 'function') throw new Error('sessionPersistence 不可用（缺少 list）')
    const entries = await sp.list()
    const archived = await archivedSet()
    const out = []
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      const h = entry && typeof entry === 'object' && entry.header && typeof entry.header === 'object'
        ? entry.header
        : entry
      const id = h && h.id
      if (typeof id !== 'string' || !id) continue
      const sizeBytes = entry && typeof entry.sizeBytes === 'number' ? entry.sizeBytes : null
      out.push({
        id,
        title: await titleOf(id),
        archived: archived.has(id),
        // a session whose body is a few hundred bytes is just a header —
        // no conversation to merge, so hide it from the picker
        empty: sizeBytes === null ? false : sizeBytes < 2048,
        version: h && h.version,
        cwd: h && h.cwd ? h.cwd : null,
        createdAt: h && h.createdAt,
        isSeeded: !!(h && h.isSeeded),
        sizeBytes,
      })
    }
    return out
  }

  /** Set of archived session ids, from the workspace index (global.archivedSessionIds). */
  async function archivedSet() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'workspace.json'), 'utf8'))
      const ids = j && j.global && Array.isArray(j.global.archivedSessionIds) ? j.global.archivedSessionIds : []
      return new Set(ids)
    } catch {
      return new Set()
    }
  }

  /** Read the cached session title (session_projcache index), same source as the sidebar. */
  async function titleOf(sid) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'session_projcache', 'sessions', sid + '.json'), 'utf8'))
      const t = c && c.record && c.record.rows && c.record.rows.title && c.record.rows.title.val
      return (typeof t === 'string' && t.trim() !== '') ? t.trim().slice(0, 200) : null
    } catch {
      return null
    }
  }

  async function readEvents(id) {
    const sp = persistence()
    if (!sp) return null
    if (typeof sp.readFrom === 'function') {
      try {
        const out = await sp.readFrom(id, 0)
        return out && Array.isArray(out.events) ? out.events : null
      } catch {
        return null
      }
    }
    if (typeof sp.open === 'function') {
      let handle
      try {
        handle = await sp.open(id, 'read')
        const out = await handle.read(0, Number.MAX_SAFE_INTEGER)
        return out && Array.isArray(out.events) ? out.events : null
      } catch {
        return null
      } finally {
        if (handle && typeof handle.close === 'function') {
          try { await handle.close() } catch { /* best-effort */ }
        }
      }
    }
    return null
  }

  /** Create a new session via the host persistence service. */
  async function createSession(header, events) {
    const sp = persistence()
    if (!sp || typeof sp.create !== 'function') throw new Error('sessionPersistence 不可用（缺少 create）')
    const handle = await sp.create(header)
    if (handle && typeof handle.append === 'function') {
      try {
        await handle.append(events)
        if (typeof handle.flush === 'function') await handle.flush()
      } finally {
        if (typeof handle.close === 'function') {
          try { await handle.close() } catch { /* best-effort */ }
        }
      }
      return
    }
    if (typeof sp.append === 'function') {
      await sp.append(header.id, events)
      return
    }
    throw new Error('sessionPersistence 写入面不可用（create 未返回写句柄，且没有 append(id, events)）')
  }

  /** Build a host-acceptable header from merge inputs. */
  function buildHeader({ firstHeader, cwd, agentPreset }) {
    const header = { version: 4, isSeeded: false, delegationDepth: 0 }
    header.id = 'session-merge-' + randomUUID()
    header.createdAt = Date.now()
    if (cwd && typeof cwd === 'string' && isAbsolute(cwd)) header.cwd = cwd
    else if (firstHeader && typeof firstHeader.cwd === 'string' && isAbsolute(firstHeader.cwd)) header.cwd = firstHeader.cwd
    if (agentPreset && typeof agentPreset === 'string') header.agentPreset = agentPreset
    else if (firstHeader && typeof firstHeader.agentPreset === 'string') header.agentPreset = firstHeader.agentPreset
    const clean = {}
    for (const k of HEADER_FIELDS) {
      if (header[k] !== undefined) clean[k] = header[k]
    }
    return clean
  }

  /** The merge pipeline. */
  async function doMerge(sessionIds, opts = {}) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new Error('需要至少一个 sessionId')
    }
    if (sessionIds.length > 16) {
      throw new Error('一次最多合并 16 个会话（当前 ' + sessionIds.length + '）')
    }
    const sp = persistence()
    if (!sp) throw new Error('sessionPersistence 不可用')

    const groups = []
    for (const id of sessionIds) {
      const events = await readEvents(id)
      if (events === null) throw new Error('无法读取会话 ' + id)
      groups.push({ id, events })
    }
    const { events } = mergeEvents(groups)
    if (events.length === 0) throw new Error('合并后事件为空（源会话可能没有内容）')

    // first source header (for cwd / agentPreset defaults)
    let firstHeader = null
    try {
      const rec = groups[0]
      if (typeof sp.readFrom === 'function') {
        const out = await sp.readFrom(groups[0].id, 0)
        firstHeader = out && out.meta ? out.meta : null
      } else {
        const handle = await sp.open(groups[0].id, 'read')
        try { firstHeader = handle.header || null } finally { if (handle.close) { try { await handle.close() } catch {} } }
      }
    } catch { /* header defaulting is best-effort */ }

    const header = buildHeader({
      firstHeader,
      cwd: opts.cwd,
      agentPreset: opts.agentPreset,
    })
    await createSession(header, events)
    return { sessionId: header.id, eventCount: events.length, sources: groups.map((g) => g.id) }
  }

  function textOfContent(content) {
    if (!Array.isArray(content)) return ''
    return content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n')
  }

  /** Real conversation messages for the picker preview (all of them, per-message cap). */
  async function previewMessages(id) {
    const events = await readEvents(id)
    if (!events) return null
    const msgs = []
    for (const ev of events) {
      if (ev && ev.type === 'user/message' && ev.data) {
        const sk = ev.data.source && ev.data.source.kind
        if (sk && sk !== 'user') continue
        const t = textOfContent(ev.data.content)
        if (t && t.trim() !== '' && !t.trim().startsWith('<system-reminder>')) {
          msgs.push({ role: 'user', text: t.trim() })
        }
      } else if (ev && ev.type === 'assistant/message' && ev.data && ev.data.message) {
        const t = textOfContent(ev.data.message.content)
        if (t && t.trim() !== '') msgs.push({ role: 'assistant', text: t.trim() })
      }
    }
    return msgs.map((m) => ({ role: m.role, text: m.text.length > 600 ? m.text.slice(0, 600) + '…' : m.text }))
  }

  const disposer = ctx.effect(() => {
    const reg = webServer.register({
      kind: 'exact',
      path: '/dsh-session-merge/list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const sessions = await listSessions()
          sendJson(res, 200, { ok: true, sessions })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })
    const reg2 = webServer.register({
      kind: 'exact',
      path: '/dsh-session-merge/merge',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        let body = {}
        try {
          body = JSON.parse(await readBody(req)) || {}
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        }
        try {
          const out = await doMerge(body.sessionIds, { cwd: body.cwd, agentPreset: body.agentPreset })
          sendJson(res, 200, { ok: true, ...out })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })
    const reg3 = webServer.register({
      kind: 'exact',
      path: '/dsh-session-merge/preview',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        let body = {}
        try {
          body = JSON.parse(await readBody(req)) || {}
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        }
        try {
          if (typeof body.sessionId !== 'string' || !body.sessionId) {
            return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
          }
          const msgs = await previewMessages(body.sessionId)
          if (!msgs) return sendJson(res, 404, { ok: false, error: '无法读取会话 ' + body.sessionId })
          sendJson(res, 200, { ok: true, id: body.sessionId, title: await titleOf(body.sessionId), messages: msgs })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })
    return () => { reg(); reg2(); reg3() }
  }, 'dsh-session-merge: /dsh-session-merge/list + /merge + /preview routes')

  return () => disposer
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
