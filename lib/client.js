/**
 * dsh-model-gateway — Client 设置页（v2 视觉）。
 *
 * 设计原则：跟随宿主主题（--dsw-alias-* token），浅色/深色自适应；
 * 品牌色只做点缀（状态点、主按钮、聚焦边框），大面积保持中性。
 * 不 require 任何 Harness Client 包，控件自绘。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BRIDGE = '/api/dsh-model-gateway'

    const CSS = [
      /* ---------- 容器 ---------- */
      '.dshmg{max-width:720px;display:flex;flex-direction:column;gap:22px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
      '.dshmg *{box-sizing:border-box}',
      /* ---------- 头部 ---------- */
      '.dshmg-head{display:flex;align-items:flex-start;gap:12px}',
      '.dshmg-logo{flex:none;width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-bg-base)));display:flex;align-items:center;justify-content:center;margin-top:1px;color:#fff;font-size:17px}',
      '.dshmg-head h2{margin:0;font-size:16px;font-weight:650;letter-spacing:.01em}',
      '.dshmg-head .sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}',
      '.dshmg-status{margin-left:auto;flex:none;display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 10px;border-radius:20px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dshmg-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dshmg-dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:dshmg-pulse 2.4s ease-out infinite}',
      '.dshmg-dot.err{background:var(--dsw-alias-state-error-primary)}',
      '@keyframes dshmg-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}',
      /* ---------- 卡片 ---------- */
      '.dshmg-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px}',
      '.dshmg-sec{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.06em;text-transform:uppercase}',
      '.dshmg-sec::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1)}',
      /* ---------- URL 主栏 ---------- */
      '.dshmg-urlbar{display:flex;align-items:stretch;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.dshmg-urlbar:focus-within{border-color:var(--dsw-alias-brand-primary)}',
      '.dshmg-url{flex:1;min-width:0;display:flex;align-items:center;padding:11px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow-x:auto;white-space:nowrap;user-select:all}',
      '.dshmg-url code{white-space:nowrap}',
      '.dshmg-urlcopy{flex:none;border:none;border-left:1px solid var(--dsw-alias-border-l2);border-radius:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 18px;font:inherit;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:background .12s,color .12s}',
      '.dshmg-urlcopy:hover{background:var(--dsw-alias-brand-primary);color:#fff;border-color:var(--dsw-alias-brand-primary)}',
      '.dshmg-urlcopy.copied{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);color:#fff}',
      /* ---------- 按钮 ---------- */
      '.dshmg-btn{padding:7px 13px;border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);transition:border-color .12s,background .12s,color .12s,opacity .12s}',
      '.dshmg-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dshmg-btn:disabled{opacity:.45;cursor:default}',
      '.dshmg-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:550}',
      '.dshmg-btn.primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,#000)}',
      /* ---------- 徽标 ---------- */
      '.dshmg-badge{font-size:10.5px;padding:2px 8px;border-radius:20px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;background:var(--dsw-alias-bg-layer-2)}',
      '.dshmg-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}',
      '.dshmg-badge.err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}',
      '.dshmg-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent)}',
      /* ---------- 表单 ---------- */
      '.dshmg-field{display:grid;grid-template-columns:88px 1fr auto;align-items:center;gap:10px}',
      '.dshmg-field+.dshmg-field{margin-top:11px}',
      '.dshmg-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshmg-input{width:100%;padding:7px 11px;border-radius:8px;font:inherit;font-size:12.5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;transition:border-color .12s}',
      '.dshmg-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dshmg-input.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dshmg-savebar{display:flex;align-items:center;gap:10px;margin-top:14px;justify-content:flex-end}',
      '.dshmg-dirty{font-size:11.5px;color:var(--dsw-alias-state-warn-primary)}',
      /* ---------- 反馈行 ---------- */
      '.dshmg-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:10px}',
      '.dshmg-probe{margin-top:12px;padding:9px 12px;border-radius:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dshmg-probe.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.dshmg-probe.err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}',
      /* ---------- 统计 ---------- */
      '.dshmg-stats{display:flex;gap:10px;flex-wrap:wrap}',
      '.dshmg-stat{flex:1;min-width:96px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshmg-stat .num{font-size:19px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}',
      '.dshmg-stat .lbl{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:1px}',
      /* ---------- 厂商卡片 ---------- */
      '.dshmg-prov{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;overflow:hidden;margin-top:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshmg-prov summary{cursor:pointer;padding:11px 14px;display:flex;align-items:center;gap:10px;background:var(--dsw-alias-bg-layer-2);list-style:none;user-select:none}',
      '.dshmg-prov summary::-webkit-details-marker{display:none}',
      '.dshmg-prov summary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-2))}',
      '.dshmg-prov .pvdot{flex:none;width:9px;height:9px;border-radius:3px}',
      '.dshmg-prov .pvname{font-weight:600;font-size:13px}',
      '.dshmg-prov .pvid{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dshmg-prov .pvcount{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshmg-prov .arrow{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);transition:transform .15s}',
      '.dshmg-prov[open] .arrow{transform:rotate(90deg)}',
      '.dshmg-models{display:flex;flex-direction:column}',
      '.dshmg-model{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshmg-model:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshmg-model .mid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshmg-model .mname{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:1px}',
      '.dshmg-copy-mini{font-size:11px;padding:3px 9px;border-radius:6px;background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;font-family:inherit;transition:color .12s,border-color .12s}',
      '.dshmg-copy-mini:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dshmg-empty{padding:16px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}',
      /* ---------- 工具行 ---------- */
      '.dshmg-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}',
      '.dshmg-footer{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}',
    ].join('\n')

    /* ---------- 复制（剪贴板失败回退） ---------- */
    function legacyCopy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch (e) {
        return false
      }
    }
    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(
            () => true,
            () => legacyCopy(text),
          )
        }
      } catch (e) {
        // 落到回退
      }
      return Promise.resolve(legacyCopy(text))
    }

    /* 由 provider id 稳定选一个主题色，厂商卡片左侧色块 */
    const PV_COLORS = [
      'var(--dsw-alias-brand-primary)',
      'var(--dsw-alias-state-success-primary)',
      'var(--dsw-alias-state-warn-primary)',
      'var(--dsw-alias-state-idle-primary)',
      'var(--dsw-alias-state-error-primary)',
    ]
    function providerColor(id) {
      let hash = 0
      for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
      return PV_COLORS[hash % PV_COLORS.length]
    }

    /* ---------- 主复制按钮（嵌在 URL 栏右侧） ---------- */
    function UrlCopy(props) {
      const mode = React.useState('idle')
      const current = mode[0]
      const setMode = mode[1]
      const timer = React.useRef(null)
      React.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
      const onClick = () => {
        copyText(props.value).then((ok) => {
          setMode(ok ? 'copied' : 'failed')
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => setMode('idle'), 1600)
        })
      }
      return h('button', { type: 'button', className: 'dshmg-urlcopy' + (current === 'copied' ? ' copied' : ''), onClick, title: props.value }, current === 'copied' ? '已复制 ✓' : current === 'failed' ? '复制失败' : '复制')
    }

    /* ---------- 小复制按钮 ---------- */
    function MiniCopy(props) {
      const mode = React.useState('idle')
      const current = mode[0]
      const setMode = mode[1]
      const timer = React.useRef(null)
      React.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
      const onClick = () => {
        copyText(props.value).then((ok) => {
          setMode(ok ? 'copied' : 'failed')
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => setMode('idle'), 1500)
        })
      }
      return h('button', { type: 'button', className: 'dshmg-copy-mini', onClick, title: props.value }, current === 'copied' ? '已复制 ✓' : current === 'failed' ? '失败' : props.label || '复制')
    }

    /* ---------- 厂商卡片 ---------- */
    function ProviderCard(props) {
      const provider = props.provider
      const models = provider.models || []
      return h(
        'details',
        { className: 'dshmg-prov', open: models.length > 0 && models.length <= 8 },
        h(
          'summary',
          null,
          h('span', { className: 'pvdot', style: { background: providerColor(provider.id) } }),
          h('span', { className: 'pvname' }, provider.name || provider.id),
          h('span', { className: 'pvid' }, provider.id),
          provider.error !== undefined ? h('span', { className: 'dshmg-badge err' }, '读取失败') : null,
          provider.exposed === false ? h('span', { className: 'dshmg-badge warn' }, '未暴露') : null,
          h('span', { className: 'pvcount' }, models.length + ' 个模型'),
          h('span', { className: 'arrow' }, '▶'),
        ),
        provider.error !== undefined
          ? h('div', { className: 'dshmg-empty' }, provider.error)
          : models.length === 0
            ? h('div', { className: 'dshmg-empty' }, '该厂商当前没有可用模型（可能未登录或额度用尽）。')
            : h(
                'div',
                { className: 'dshmg-models' },
                models.map((model) =>
                  h(
                    'div',
                    { className: 'dshmg-model', key: model.id },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h('div', { className: 'mid' }, model.id),
                      model.ambiguous || !model.name || model.name === model.id ? null : h('div', { className: 'mname' }, model.name),
                    ),
                    model.ambiguous ? h('span', { className: 'dshmg-badge warn' }, '需写全厂商名') : null,
                    model.modalities && model.modalities.indexOf('image') >= 0 ? h('span', { className: 'dshmg-badge' }, '多模态') : null,
                    h(MiniCopy, { value: model.ambiguous ? provider.id + '/' + model.id : model.id, label: '复制 ID' }),
                  ),
                ),
              ),
      )
    }

    /* ---------- 设置页 ---------- */
    function SettingsPage() {
      const snapState = React.useState(null)
      const snapshot = snapState[0]
      const setSnapshot = snapState[1]

      const errState = React.useState(null)
      const loadError = errState[0]
      const setLoadError = errState[1]

      const savingState = React.useState(false)
      const saving = savingState[0]
      const setSaving = savingState[1]

      const noteState = React.useState(null)
      const saveNote = noteState[0]
      const setSaveNote = noteState[1]

      const probingState = React.useState(false)
      const probing = probingState[0]
      const setProbing = probingState[1]

      const probeState = React.useState(null)
      const probeResult = probeState[0]
      const setProbeResult = probeState[1]

      const draftState = React.useState({ host: '', port: '', apiKey: '', apiKeyTouched: false, dirty: false })
      const draft = draftState[0]
      const setDraft = draftState[1]

      const applySnapshot = React.useCallback((value) => {
        setSnapshot(value)
        setLoadError(null)
        setDraft((prev) => {
          if (prev.dirty === true) return prev
          const bound = value.listener && value.listener.boundPort
          return {
            host: value.config.host,
            port: String(bound !== null && bound !== undefined ? bound : value.config.port),
            apiKey: '',
            apiKeyTouched: false,
            dirty: false,
          }
        })
      }, [])

      const load = React.useCallback(() => {
        fetch(BRIDGE + '/state')
          .then((res) => res.json())
          .then((data) => {
            if (!data || data.ok !== true) throw new Error((data && data.error) || 'read failed')
            applySnapshot(data.value)
          })
          .catch((error) => setLoadError(String((error && error.message) || error)))
      }, [applySnapshot])

      React.useEffect(() => { load() }, [load])

      const setField = (key) => (event) => {
        const value = event.target.value
        setDraft((prev) => Object.assign({}, prev, { [key]: value, dirty: true }))
      }

      const save = () => {
        setSaving(true)
        setSaveNote(null)
        const payload = { host: draft.host, port: Number(draft.port) }
        if (draft.apiKeyTouched) payload.apiKey = draft.apiKey
        fetch(BRIDGE + '/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          .then((res) => res.json())
          .then((data) => {
            if (!data || data.ok !== true) throw new Error((data && data.error) || 'save failed')
            setSaveNote({ ok: true, text: '已保存，监听器正在重绑…' })
            setTimeout(() => {
              setDraft((prev) => Object.assign({}, prev, { dirty: false }))
              load()
            }, 1500)
          })
          .catch((error) => setSaveNote({ ok: false, text: String((error && error.message) || error) }))
          .then(() => setSaving(false))
      }

      const probe = (withImage) => {
        setProbing(true)
        setProbeResult(null)
        fetch(BRIDGE + '/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(withImage ? { withImage: true } : {}),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data && data.ok === true) setProbeResult({ ok: true, value: data.value })
            else setProbeResult({ ok: false, error: (data && data.error) || '未知错误' })
          })
          .catch((error) => setProbeResult({ ok: false, error: String((error && error.message) || error) }))
          .then(() => setProbing(false))
      }

      const style = h('style', null, CSS)

      if (loadError !== null) {
        return h('div', { className: 'dshmg' }, style, h('div', { className: 'dshmg-probe err' }, '读取状态失败：' + loadError))
      }
      if (snapshot === null) {
        return h('div', { className: 'dshmg' }, style, h('div', { className: 'dshmg-empty' }, '读取中…'))
      }

      const baseUrl = (snapshot.listener && snapshot.listener.baseUrl) || 'http://' + snapshot.config.host + ':' + snapshot.config.port + '/v1'
      const running = snapshot.listener && snapshot.listener.running === true
      const providers = snapshot.providers || []
      const totalModels = providers.reduce((sum, p) => sum + ((p.models && p.models.length) || 0), 0)
      const activeProviders = providers.filter((p) => (p.models && p.models.length) > 0).length
      const firstModel = (() => {
        for (const p of providers) if (p.models && p.models.length > 0) return p.models[0].id
        return 'deepseek-v4.1-flash'
      })()
      const stats = snapshot.stats || {}

      return h(
        'div',
        { className: 'dshmg' },
        style,

        /* ---- 头部 ---- */
        h(
          'div',
          { className: 'dshmg-head' },
          h('div', { className: 'dshmg-logo' }, '⇄'),
          h('div', null, h('h2', null, '模型网关'), h('div', { className: 'sub' }, '把本 Harness 已接入的模型开放为本地 OpenAI 兼容接口')),
          h('div', { className: 'dshmg-status' }, h('span', { className: 'dshmg-dot ' + (running ? 'ok' : 'err') }), running ? '监听中 · 端口 ' + snapshot.listener.boundPort : '未监听'),
        ),
        running && snapshot.listener.portFellBack === true
          ? h(
              'div',
              { className: 'dshmg-probe err', style: { marginTop: -12 } },
              '⚠ 配置的端口 ' + snapshot.config.port + ' 被其他进程占用，已自动改用 ' + snapshot.listener.boundPort + '。请把客户端的 Base URL 更新为上方地址，或换一个端口后重新保存。',
            )
          : null,

        /* ---- 接入卡片 ---- */
        h(
          'div',
          { className: 'dshmg-card' },
          h('div', { className: 'dshmg-sec' }, '接入'),
          h('div', { className: 'dshmg-urlbar' }, h('div', { className: 'dshmg-url' }, h('code', null, baseUrl)), h(UrlCopy, { value: baseUrl })),
          h(
            'div',
            { className: 'dshmg-tools' },
            h(MiniCopy, { value: baseUrl + '/chat/completions', label: '复制 chat 端点' }),
            h(MiniCopy, {
              value: JSON.stringify({ model: firstModel, messages: [{ role: 'user', content: '你好' }], stream: false }, null, 2),
              label: '复制请求示例',
            }),
            h('button', { type: 'button', className: 'dshmg-btn', onClick: () => probe(false), disabled: probing }, probing ? '测试中…' : '▶ 用真实模型试一下'),
            h('button', { type: 'button', className: 'dshmg-btn', onClick: () => probe(true), disabled: probing || !snapshot.attachmentsAvailable }, '🖼 试图片链路'),
          ),
          probeResult !== null
            ? probeResult.ok
              ? h('div', { className: 'dshmg-probe ok' }, '✓ ' + probeResult.value.model + ' · ' + probeResult.value.ms + 'ms · 「' + String(probeResult.value.preview || '').trim() + '」')
              : h('div', { className: 'dshmg-probe err' }, '✗ ' + probeResult.error)
            : null,
          h('div', { className: 'dshmg-note' }, '把上面的地址填进 Postman / Cherry Studio / 任意 OpenAI SDK 的 Base URL 即可。该监听器独立于 DSH 自身端口，改端口不影响当前界面。'),
        ),

        /* ---- 统计 ---- */
        h(
          'div',
          { className: 'dshmg-stats' },
          h('div', { className: 'dshmg-stat' }, h('div', { className: 'num' }, String(activeProviders)), h('div', { className: 'lbl' }, '可用厂商')),
          h('div', { className: 'dshmg-stat' }, h('div', { className: 'num' }, String(totalModels)), h('div', { className: 'lbl' }, '可用模型')),
          h('div', { className: 'dshmg-stat' }, h('div', { className: 'num' }, String(stats.requests || 0)), h('div', { className: 'lbl' }, '累计请求')),
          h('div', { className: 'dshmg-stat' }, h('div', { className: 'num', style: (stats.errors || 0) > 0 ? { color: 'var(--dsw-alias-state-error-primary)' } : null }, String(stats.errors || 0)), h('div', { className: 'lbl' }, '失败次数')),
        ),

        /* ---- 监听配置 ---- */
        h(
          'div',
          { className: 'dshmg-card' },
          h('div', { className: 'dshmg-sec' }, '监听配置'),
          h('div', { className: 'dshmg-field' }, h('label', null, '监听地址'), h('input', { className: 'dshmg-input mono', type: 'text', value: draft.host, onChange: setField('host'), placeholder: '127.0.0.1' }), h('span', { className: 'dshmg-badge' }, '改 0.0.0.0 将暴露到局域网')),
          h('div', { className: 'dshmg-field' }, h('label', null, '端口'), h('input', { className: 'dshmg-input mono', type: 'number', value: draft.port, onChange: setField('port'), min: 0, max: 65535 }), h('span', { className: 'dshmg-badge' }, '0 = 系统分配')),
          h('div', { className: 'dshmg-field' }, h('label', null, '本地令牌'), h('input', {
            className: 'dshmg-input',
            type: 'password',
            value: draft.apiKey,
            placeholder: snapshot.config.hasApiKey ? '已设置（留空保持不变）' : '留空 = 不校验',
            onChange: (event) => setDraft((prev) => Object.assign({}, prev, { apiKey: event.target.value, apiKeyTouched: true, dirty: true })),
          }), h('span', { className: 'dshmg-badge' }, 'Bearer / x-api-key')),
          h(
            'div',
            { className: 'dshmg-savebar' },
            draft.dirty ? h('span', { className: 'dshmg-dirty' }, '● 有未保存的修改') : null,
            h('button', { type: 'button', className: 'dshmg-btn primary', onClick: save, disabled: saving || !draft.dirty }, saving ? '保存中…' : '保存并重绑监听器'),
          ),
          saveNote !== null ? h('div', { className: saveNote.ok ? 'dshmg-probe ok' : 'dshmg-probe err', style: { marginTop: 10 } }, saveNote.text) : null,
        ),

        /* ---- 厂商与模型 ---- */
        h(
          'div',
          { className: 'dshmg-card' },
          h(
            'div',
            { className: 'dshmg-sec' },
            '厂商与模型',
            h('button', { type: 'button', className: 'dshmg-copy-mini', onClick: load }, '刷新'),
          ),
          providers.length === 0
            ? h('div', { className: 'dshmg-empty' }, '没有已注册的模型适配器。请先在「模型」设置里接入 WorkBuddy 或 Qoder。')
            : providers.map((provider) => h(ProviderCard, { key: provider.id, provider })),
          h('div', { className: 'dshmg-note' }, '模型名写 provider/model 最稳；标了「需写全厂商名」的模型跨厂商重名，裸名会返回 400 并列出候选。'),
        ),

        h('div', { className: 'dshmg-footer' }, '凭据不经过本插件，仍由 WorkBuddy / Qoder 插件各自保管 · dsh-model-gateway'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                { name: 'settings.section', id: 'dsh-model-gateway', order: 60, label: () => '模型网关' },
                SettingsPage,
              ),
            ),
          'dsh-model-gateway: settings section',
        )
      },
    }
  },
})
