/**
 * Client half of @local/dsh-mcp-connector.
 *
 * Registers one page inside Settings: the MCP server registry. Everything the
 * page renders comes from the Host half's same-origin management API — this file
 * owns presentation, draft editing and the pre-flight probe flow, never protocol
 * state.
 *
 * Layout follows the shell's settings pages: a 760px measure, 18px/600 section
 * heading, 13px tertiary intro, hairline-separated rows and token-only colours so
 * light/dark both work.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-connector',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'mcpConnector'
    const API = '/dsh-mcp-connector/api'
    const POLL_MS = 3000

    // ── copy ──────────────────────────────────────────────────────────────────
    // The plugin's identity label is English — `MCP Connector`, derived from the
    // package name `@local/dsh-mcp-connector` the way DSH names its own plugins.
    // It is intentionally identical in both dictionaries: it is the product name,
    // not a translatable sentence. Everything below it stays localized.
    const ZH = {
      title: 'MCP Connector',
      intro: '把外部 MCP 服务器的工具接入本部署：以 mcp__<服务器>__<工具> 命名注册，随插件卸装自动注销。',
      summary: '{servers} 台服务器 · {ready} 就绪 · {tools} 个工具',
      statServers: '服务器',
      statReady: '就绪',
      statTools: '工具',
      statCalls: '调用',
      policy: '部署策略',
      policyLine: '{transport} · 握手 {timeout} · 探测 {probe}',
      registryOn: '运行时注册表开启',
      registryOff: '运行时注册表已关闭',
      add: '添加服务器',
      refresh: '刷新',
      search: '搜索服务器',
      searchPlaceholder: '搜索名称、地址或工具…',
      clearSearch: '清除搜索',
      noMatch: '没有匹配「{query}」的服务器',
      moreActions: '更多操作',
      copyTools: '复制工具名',
      copyConfig: '复制配置',
      copyDiagnostic: '复制诊断',
      import: '导入 JSON',
      export: '导出 JSON',
      empty: '还没有 MCP 服务器。添加一台，或从 Claude Desktop / VS Code 的配置导入。',
      emptyHint: 'stdio 服务器需要一个命令；HTTP 服务器需要一个 Streamable HTTP 端点。',
      loading: '加载中…',
      loadFailed: '无法读取注册表：',
      retryLoad: '重试',
      toolsCount: '{count} 个工具',
      noTools: '未发现工具',
      lastSuccess: '最近成功 {when}',
      never: '尚未成功连接',
      state: '状态',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      enable: '启用',
      disable: '禁用',
      test: '测试连接',
      retry: '重试连接',
      expand: '详情',
      collapse: '收起',
      details: '诊断与工具',
      transportLabel: '传输',
      protocolLabel: '协议版本',
      capabilitiesLabel: '服务器能力',
      serverLabel: '服务器信息',
      toolsLabel: '工具',
      statsLabel: '统计',
      lastSuccessLabel: '最近成功',
      errorLabel: '最近错误',
      notesLabel: '备注',
      phaseLabel: '阶段',
      codeLabel: '错误码',
      detailLabel: '细节',
      configLabel: '连接参数',
      envKeys: '环境变量键',
      headerNames: '请求头',
      none: '无',
      statsLine: '尝试 {attempts} · 重连 {reconnects} · 调用 {calls}（失败 {errors}）',

      editorAdd: '添加服务器',
      editorEdit: '编辑服务器',
      editorHint: '保存后只热更新这一条连接，插件本身不重挂。',
      dialogAdd: '添加自定义 MCP',
      dialogEdit: '编辑自定义 MCP',
      dialogSubAdd: '新增连接；配置写入运行时注册表',
      dialogSubEdit: '更新连接配置；MCP 名称和 serverName 保持不变。保存位置',
      dialogClose: '关闭',
      tabForm: '表单',
      tabJson: 'JSON',
      jsonHint: '可直接编辑该服务器的 JSON；切回表单会应用合法内容。',
      jsonInvalid: 'JSON 不合法：{message}',
      actionAdd: '添加 MCP',
      actionSave: '保存 MCP',
      fieldTimeout: '超时时间（毫秒，可选）',
      fieldTimeoutHint: '单次工具调用的最长等待时间，最小 1000 毫秒；留空用默认策略。',
      timeoutError: '超时时间至少 1000 毫秒，或留空使用默认。',
      namePlaceholder: '例如 github-search',
      agentNameHint: 'Agent 将看到 serverName：{name}',
      urlPlaceholder: 'https://example.com/mcp',
      headerAdd: '+ 添加 Header',
      headerName: 'Header 名称',
      headerValue: '值',
      headerRemove: '删除该请求头',

      headerReveal: '显示值',
      headerHide: '隐藏值',
      fieldName: '服务器名（工具命名空间）',
      fieldNameHint: '匹配 [A-Za-z0-9_-]{1,32}；作为工具前缀后不可修改，改名请删除后重建。',
      fieldTransport: '传输类型',
      fieldCommand: '命令',
      fieldCommandHint: '可执行文件名或绝对路径，例如 npx、node、python。',
      fieldArgs: '参数',
      fieldArgsHint: '每行一个参数，或写成一行由空格分隔（支持引号）。',
      fieldEnv: '环境变量',
      fieldEnvHint: '每行 KEY=VALUE。凭据会被脱敏显示。',
      fieldCwd: '工作目录',
      fieldUrl: '服务地址',
      fieldUrlHint: 'Streamable HTTP 端点，例如 https://example.com/mcp。',
      fieldHeaders: '请求头',

      authTitle: '鉴权',
      authHint: '头名从令牌库选择，右侧填令牌。保存后只写入 DSH 凭据库，注册表里只留 ${credential:…} 引用。',
      authHeaderLabel: '请求头',
      authValueLabel: '令牌',
      authApply: '存入凭据并应用',
      authBind: '存入凭据并绑定',
      authApplied: '已存入凭据库并应用到连接',
      authBound: '已存入凭据库；保存服务器后生效',
      authBoundRef: '已绑定 {ref}',
      authChange: '更换',
      authReveal: '显示',
      authHide: '隐藏',
      authNeedValue: '请先填写令牌。',
      authNeedName: '请先填写服务器名，再生成凭据引用。',
      authPlain: '当前为明文值，建议改为凭据引用',
      advShow: '高级：其他请求头（{count}）',
      advHide: '收起其他请求头',

      save: '保存',
      saving: '保存中…',
      testDraft: '测试连接',
      testing: '测试中…',
      requiredName: '请填写服务器名。',
      requiredCommand: 'stdio 服务器需要命令。',
      requiredUrl: 'HTTP 服务器需要端点地址。',
      transportStdio: 'stdio（本地子进程）',
      transportHttp: 'Streamable HTTP',
      transportSse: 'HTTP + SSE（旧版）',

      probeOk: '连接有效：{version} · {transport} · {count} 个工具',
      probeFailed: '连接失败',
      probeEmptyTools: '连接有效，但服务器没有暴露任何工具。',
      probeCapabilities: '能力：{caps}',
      probeTools: '工具：{tools}',
      probeElapsed: '耗时 {ms}ms',
      probeWarnings: '提示',
      probeSaveHint: '测试结果不作为保存前提：保存后还会得到一次真实挂载结果。',

      importTitle: '导入 JSON',
      importHint: '支持 {"mcpServers":{…}}、{"servers":{…}}、裸 map、单条对象与对象数组；导入前逐条校验。',
      importMode: '写入方式',
      importMerge: '合并（同名的更新）',
      importReplace: '全量覆盖（未出现的删除）',
      importRun: '校验并导入',
      importRunning: '导入中…',
      importRejected: '{count} 条未通过校验，本次没有写入。',
      importAccepted: '可接受：{names}',
      importDone: '{message}',
      importEmpty: '请粘贴 JSON。',
      rejectedRow: '#{index} {name} · {code} · {message}',
      exportTitle: '导出 JSON',
      exportFormat: '结构',
      exportMcp: '{"mcpServers": {…}}',
      exportMap: '裸 map',
      exportArray: '对象数组',
      exportRun: '生成',
      copy: '复制',
      copied: '已复制',
      close: '关闭',
      receipt: '操作回执',
      warnings: '提示',
      staleHint: '列表每 3 秒自动同步。',
    }

    const EN = {
      title: 'MCP Connector',
      intro: 'Bridge external MCP servers into this deployment: tools register as mcp__<server>__<tool> and unregister with the plugin.',
      summary: '{servers} servers · {ready} ready · {tools} tools',
      statServers: 'Servers',
      statReady: 'Ready',
      statTools: 'Tools',
      statCalls: 'Calls',
      policy: 'Deployment policy',
      policyLine: '{transport} · handshake {timeout} · probe {probe}',
      registryOn: 'Runtime registry on',
      registryOff: 'Runtime registry off',
      add: 'Add server',
      refresh: 'Refresh',
      search: 'Search servers',
      searchPlaceholder: 'Search name, endpoint or tool…',
      clearSearch: 'Clear search',
      noMatch: 'No server matches “{query}”',
      moreActions: 'More actions',
      copyTools: 'Copy tool names',
      copyConfig: 'Copy config',
      copyDiagnostic: 'Copy diagnostic',
      import: 'Import JSON',
      export: 'Export JSON',
      empty: 'No MCP servers yet. Add one, or import a Claude Desktop / VS Code config.',
      emptyHint: 'A stdio server needs a command; an HTTP server needs a Streamable HTTP endpoint.',
      loading: 'Loading…',
      loadFailed: 'Cannot read the registry: ',
      retryLoad: 'Retry',
      toolsCount: '{count} tools',
      noTools: 'No tools discovered',
      lastSuccess: 'Last success {when}',
      never: 'Never connected',
      state: 'State',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Delete',
      cancel: 'Cancel',
      enable: 'Enable',
      disable: 'Disable',
      test: 'Test connection',
      retry: 'Retry',
      expand: 'Details',
      collapse: 'Hide',
      details: 'Diagnostics and tools',
      transportLabel: 'Transport',
      protocolLabel: 'Protocol',
      capabilitiesLabel: 'Capabilities',
      serverLabel: 'Server',
      toolsLabel: 'Tools',
      statsLabel: 'Stats',
      lastSuccessLabel: 'Last success',
      errorLabel: 'Last error',
      notesLabel: 'Notes',
      phaseLabel: 'Phase',
      codeLabel: 'Code',
      detailLabel: 'Detail',
      configLabel: 'Connection',
      envKeys: 'Env keys',
      headerNames: 'Headers',
      none: 'None',
      statsLine: '{attempts} attempts · {reconnects} reconnects · {calls} calls ({errors} failed)',

      editorAdd: 'Add server',
      editorEdit: 'Edit server',
      editorHint: 'Saving swaps only this connection; the plugin itself is not remounted.',
      dialogAdd: 'Add custom MCP',
      dialogEdit: 'Edit custom MCP',
      dialogSubAdd: 'New connection; stored in the runtime registry',
      dialogSubEdit: 'Update the connection; name and serverName stay unchanged. Saved in',
      dialogClose: 'Close',
      tabForm: 'Form',
      tabJson: 'JSON',
      jsonHint: 'Edit this server as JSON; switching back to the form applies whatever parses.',
      jsonInvalid: 'Invalid JSON: {message}',
      actionAdd: 'Add MCP',
      actionSave: 'Save MCP',
      fieldTimeout: 'Timeout (ms, optional)',
      fieldTimeoutHint: 'Longest wait for one tool call, at least 1000 ms; leave blank for the default policy.',
      timeoutError: 'Use at least 1000 ms, or leave it blank for the default.',
      namePlaceholder: 'e.g. github-search',
      agentNameHint: 'Agents will see serverName: {name}',
      urlPlaceholder: 'https://example.com/mcp',
      headerAdd: '+ Add header',
      headerName: 'Header',
      headerValue: 'Value',
      headerRemove: 'Remove this header',
      headerReveal: 'Show value',
      headerHide: 'Hide value',
      fieldName: 'Server name (tool namespace)',
      fieldNameHint: 'Matches [A-Za-z0-9_-]{1,32}; immutable once it prefixes tool names — rename by delete + create.',
      fieldTransport: 'Transport',
      fieldCommand: 'Command',
      fieldCommandHint: 'Executable name or absolute path, e.g. npx, node, python.',
      fieldArgs: 'Arguments',
      fieldArgsHint: 'One argument per line, or one shell-style line (quotes supported).',
      fieldEnv: 'Environment',
      fieldEnvHint: 'One KEY=VALUE per line. Credentials are redacted on display.',
      fieldCwd: 'Working directory',
      fieldUrl: 'Endpoint',
      fieldUrlHint: 'Streamable HTTP endpoint, e.g. https://example.com/mcp.',
      fieldHeaders: 'Headers',
      fieldHeadersHint: 'One KEY: VALUE per line. The auth header is managed above; use this for tenant, version and other non-secret headers. Secrets may also be written as ${credential:NAME}.',
      authTitle: 'Authentication',
      authHint: 'Pick the header name from the token library and enter the token. Saving writes only to the DSH credential store; the registry keeps a ${credential:…} reference.',
      authHeaderLabel: 'Header',
      authValueLabel: 'Token',
      authApply: 'Store and apply',
      authBind: 'Store and bind',
      authApplied: 'Stored in credentials and applied to the connection',
      authBound: 'Stored; applies when the server is saved',
      authBoundRef: 'Bound to {ref}',
      authChange: 'Change',
      authReveal: 'Show',
      authHide: 'Hide',
      authNeedValue: 'Enter the token first.',
      authNeedName: 'Enter a server name before generating the credential reference.',
      authPlain: 'Stored as a literal value; prefer a credential reference',
      advShow: 'Advanced: other headers ({count})',
      advHide: 'Hide other headers',
      save: 'Save',
      saving: 'Saving…',
      testDraft: 'Test connection',
      testing: 'Testing…',
      requiredName: 'Enter a server name.',
      requiredCommand: 'A stdio server needs a command.',
      requiredUrl: 'An HTTP server needs an endpoint.',
      transportStdio: 'stdio (local process)',
      transportHttp: 'Streamable HTTP',
      transportSse: 'HTTP + SSE (legacy)',

      probeOk: 'Reachable: {version} · {transport} · {count} tools',
      probeFailed: 'Connection failed',
      probeEmptyTools: 'Reachable, but the server exposes no tools.',
      probeCapabilities: 'Capabilities: {caps}',
      probeTools: 'Tools: {tools}',
      probeElapsed: '{ms}ms',
      probeWarnings: 'Notes',
      probeSaveHint: 'A probe never blocks saving: saving also returns a real mount result.',

      importTitle: 'Import JSON',
      importHint: 'Accepts {"mcpServers":{…}}, {"servers":{…}}, a bare map, a single object and an object array; every row is validated first.',
      importMode: 'Write mode',
      importMerge: 'Merge (upsert by name)',
      importReplace: 'Replace all (missing servers are removed)',
      importRun: 'Validate and import',
      importRunning: 'Importing…',
      importRejected: '{count} rows failed validation; nothing was written.',
      importAccepted: 'Accepted: {names}',
      importDone: '{message}',
      importEmpty: 'Paste JSON first.',
      rejectedRow: '#{index} {name} · {code} · {message}',
      exportTitle: 'Export JSON',
      exportFormat: 'Shape',
      exportMcp: '{"mcpServers": {…}}',
      exportMap: 'Bare map',
      exportArray: 'Object array',
      exportRun: 'Generate',
      copy: 'Copy',
      copied: 'Copied',
      close: 'Close',
      receipt: 'Receipt',
      warnings: 'Notes',
      staleHint: 'The list syncs every 3 seconds.',
    }

    // ── styles ────────────────────────────────────────────────────────────────
    const CSS = [
      '.mc-root{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;',
      'color:var(--dsw-alias-label-primary)}',
      '.mc-head{display:flex;flex-direction:column;gap:4px}',
      '.mc-title{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.mc-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);text-wrap:pretty}',
      '.mc-stats{display:flex;flex-wrap:wrap;gap:18px;padding:12px 14px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.mc-stat{display:flex;flex-direction:column;gap:2px;min-width:64px}',
      '.mc-stat-value{font-size:18px;font-weight:600;line-height:24px;font-variant-numeric:tabular-nums}',
      '.mc-stat-label{font-size:11px;line-height:16px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}',
      '.mc-policy{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11.5px;line-height:17px;',
      'color:var(--dsw-alias-label-tertiary);margin-top:8px;padding-top:8px;',
      'border-top:.5px solid var(--dsw-alias-border-l2);width:100%}',
      '.mc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.mc-toolbar-spacer{flex:1}',
      '.mc-btn{height:28px;padding:0 10px;cursor:pointer;font:inherit;font-size:12.5px;',
      'color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l4);',
      'border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);',
      'transition:background-color .12s ease}',
      '.mc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
      '.mc-btn:disabled{cursor:default;opacity:.5}',
      '.mc-btn-primary{color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-brand-primary));',
      'border-color:transparent;background:var(--dsw-alias-brand-primary)}',
      '.mc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.06)}',
      '.mc-btn-danger{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}',
      '.mc-btn-sm{height:26px;font-size:12px;padding:0 9px}',
      '.mc-btn:focus-visible,.mc-input:focus-visible,.mc-textarea:focus-visible,.mc-select:focus-visible',
      '{outline:var(--dsw-focus-ring-width) solid',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.mc-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
      '.mc-item{display:flex;flex-direction:column;gap:8px;padding:13px 2px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.mc-item:last-child{border-bottom:0}',
      '.mc-item-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.mc-name{font-size:14px;font-weight:500;line-height:20px;word-break:break-all}',
      '.mc-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
      'word-break:break-word;font-variant-numeric:tabular-nums}',
      '.mc-meta code{font:12px/18px ui-monospace,SFMono-Regular,monospace}',
      '.mc-err{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}',
      '.mc-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.mc-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;',
      'border-radius:999px;font-size:11.5px;line-height:20px;',
      'border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
      '.mc-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}',
      '[data-tone="ready"] .mc-dot{background:var(--dsw-alias-state-business-primary)}',
      '[data-tone="degraded"] .mc-dot{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}',
      '[data-tone="busy"] .mc-dot{background:var(--dsw-alias-state-business-primary);animation:mc-pulse 1.2s ease-in-out infinite}',
      '[data-tone="error"] .mc-dot{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '[data-tone="off"] .mc-dot{background:var(--dsw-alias-border-l4)}',
      '@keyframes mc-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '.mc-panel{display:flex;flex-direction:column;gap:12px;padding:14px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.mc-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.mc-panel-title{margin:0;font-size:14px;font-weight:600;line-height:22px}',
      '.mc-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.mc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}',
      '.mc-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.mc-field-full{grid-column:1 / -1}',
      '.mc-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.mc-input,.mc-select,.mc-textarea{box-sizing:border-box;width:100%;font:inherit;font-size:12.5px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:5px 8px}',
      '.mc-input,.mc-select{height:28px}',
      '.mc-textarea{min-height:58px;resize:vertical;font:12px/17px ui-monospace,SFMono-Regular,monospace}',
      '.mc-input:disabled{opacity:.6;cursor:not-allowed}',
      '.mc-row-inline{display:flex;align-items:center;gap:8px}',
      '.mc-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.mc-empty{display:flex;flex-direction:column;gap:4px;padding:22px 2px;text-align:left}',
      '.mc-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12px;line-height:18px}',
      '.mc-kv dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.mc-kv dd{margin:0;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.mc-mono{font:12px/18px ui-monospace,SFMono-Regular,monospace;word-break:break-all}',
      '.mc-tag{display:inline-flex;align-items:center;height:20px;padding:0 6px;margin:0 4px 4px 0;',
      'border-radius:var(--dsw-radius-sm);font:11.5px/20px ui-monospace,SFMono-Regular,monospace;',
      'background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
      '.mc-list-plain{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;',
      'font-size:12px;line-height:18px}',
      '.mc-note{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);',
      'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-bg-layer-2);border-left:2px solid var(--dsw-alias-border-l4)}',
      '.mc-note-error{border-left-color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.mc-note-ok{border-left-color:var(--dsw-alias-state-business-primary)}',
      '.mc-radio{display:flex;flex-wrap:wrap;gap:12px}',
      '.mc-radio label{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.mc-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.mc-toast{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.mc-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mc-cred{display:flex;flex-direction:column;gap:6px;padding:10px 12px;',
      'border:.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}',
      '.mc-cred-title{margin:0;font-size:12.5px;font-weight:500;line-height:18px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.mc-cred-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mc-cred-ok{color:var(--dsw-alias-state-business-primary)}',
      '.mc-cred-miss{color:var(--dsw-alias-label-tertiary)}',
      // Modal sheet for add/edit: overlay + card, tabs, header rows, footer.
      '.mc-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;',
      'justify-content:center;padding:6vh 16px;overflow:auto;background:rgba(0,0,0,.45)}',
      '.mc-dialog{display:flex;flex-direction:column;width:100%;max-width:660px;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md);box-shadow:0 18px 48px rgba(0,0,0,.28)}',
      '.mc-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px 8px}',
      '.mc-dialog-heading{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.mc-dialog-title{margin:0;font-size:16px;font-weight:600;line-height:24px}',
      '.mc-dialog-sub{margin:0;font-size:12px;line-height:18px;word-break:break-all;color:var(--dsw-alias-label-tertiary)}',
      '.mc-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;',
      'padding:0;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-tertiary);',
      'background:transparent;border:0;border-radius:var(--dsw-radius-sm);flex:none}',
      '.mc-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.mc-icon-btn:disabled{opacity:.4;cursor:default}',
      '.mc-tabs{display:flex;gap:18px;padding:0 18px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.mc-tab{position:relative;padding:8px 1px 9px;font:inherit;font-size:13px;cursor:pointer;',
      'background:0 0;border:0;color:var(--dsw-alias-label-tertiary)}',
      '.mc-tab[data-active="true"]{color:var(--dsw-alias-label-primary)}',
      '.mc-tab[data-active="true"]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;',
      'border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}',
      '.mc-dialog-body{padding:16px 18px;overflow:auto;max-height:min(66vh,560px)}',
      '.mc-form{display:flex;flex-direction:column;gap:14px}',
      '.mc-field-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.mc-link-btn{padding:0;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-link);background:0 0;border:0}',
      '.mc-link-btn:hover{text-decoration:underline}',
      '.mc-header-row{display:grid;grid-template-columns:1fr 1fr auto auto;gap:6px;align-items:center;margin-top:6px}',
      '.mc-input-locked{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}',
      '.mc-dialog-foot{display:flex;align-items:center;gap:8px;padding:12px 18px;',
      'border-top:.5px solid var(--dsw-alias-border-l2)}',
      // Icons, search, row disclosure, skeleton.
      '.mc-icon{display:block;flex:none}',
      '.mc-icon-open{transform:rotate(90deg)}',
      '.mc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px}',
      '.mc-btn-icon{width:30px;padding:0}',
      '.mc-icon-btn{width:28px;height:28px}',
      '.mc-search{position:relative;display:flex;align-items:center;flex:1 1 220px;max-width:340px;min-width:0}',
      '.mc-search-icon{position:absolute;left:8px;color:var(--dsw-alias-label-tertiary);pointer-events:none}',
      '.mc-search-input{padding-left:28px;padding-right:28px}',
      '.mc-search-clear{position:absolute;right:1px}',
      '.mc-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mc-disclosure{display:inline-flex;align-items:center;gap:6px;padding:0;font:inherit;',
      'color:inherit;background:0 0;border:0;cursor:pointer;text-align:left}',
      '.mc-disclosure:focus-visible{outline:var(--dsw-focus-ring-width) solid',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px}',
      '.mc-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;',
      'font-size:11.5px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
      '.mc-spacer{flex:1 1 auto}',
      '.mc-more{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.mc-details{display:flex;flex-direction:column;gap:10px;padding:10px 12px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.mc-pre{margin:0;max-height:220px;overflow:auto;padding:8px 10px;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);',
      'font:12px/17px ui-monospace,SFMono-Regular,monospace;color:var(--dsw-alias-label-secondary)}',
      '.mc-skeleton{display:flex;flex-direction:column;gap:8px;padding:14px 2px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.mc-skel-line{display:block;height:10px;border-radius:6px;',
      'background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-3),var(--dsw-alias-bg-layer-2));',
      'background-size:200% 100%;animation:mc-shimmer 1.4s ease-in-out infinite}',
      '.mc-skel-title{width:32%;height:14px}',
      '.mc-skel-meta{width:68%}',
      '.mc-skel-short{width:44%}',
      '@keyframes mc-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '@media (max-width:560px){.mc-grid{grid-template-columns:1fr}',
      '.mc-search{flex-basis:100%;max-width:none}',
      '.mc-header-row{grid-template-columns:1fr auto auto}',
      '.mc-header-row .mc-input:first-child{grid-column:1 / -1}}',
      '@media (prefers-reduced-motion:reduce){.mc-dot{animation:none}.mc-skel-line{animation:none}}',
    ].join('')

    function installStyles() {
      if (typeof document === 'undefined') return
      const id = '@local/dsh-mcp-connector/connector.css'
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-mcp-connector'
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    const TONES = {
      ready: 'ready',
      degraded: 'degraded',
      connecting: 'busy',
      initializing: 'busy',
      reconnecting: 'busy',
      draft: 'off',
      disabled: 'off',
      error: 'error',
    }

    function toneOf(state) {
      return TONES[state] ?? 'off'
    }

    function formatTime(iso, locale) {
      if (!iso) return null
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return null
      try {
        return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date)
      } catch {
        return date.toISOString().slice(5, 16).replace('T', ' ')
      }
    }

    /** Parse "KEY=VALUE" lines into an object; blank lines are skipped. */
    function parsePairLines(text, separator) {
      const output = {}
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const index = trimmed.indexOf(separator)
        if (index <= 0) continue
        const key = trimmed.slice(0, index).trim()
        const value = trimmed.slice(index + separator.length).trim().replace(/^["']|["']$/g, '')
        if (key !== '') output[key] = value
      }
      return output
    }

    function formatPairLines(map, separator) {
      return Object.entries(map ?? {})
        .map(([key, value]) => (separator === '=' ? `${key}=${value}` : `${key}: ${value}`))
        .join('\n')
    }

    /** Header names the auth row can bind; the library is fixed, not free text. */
    const AUTH_HEADER_LIBRARY = ['modao-token', 'Authorization', 'X-Api-Key', 'X-Auth-Token']

    /** One line's `KEY: VALUE` split, or undefined. */
    function splitHeaderLine(line) {
      const index = line.indexOf(':')
      if (index <= 0) return undefined
      return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() }
    }

    /** Read one header value out of the textarea text (case-insensitive name). */
    function readHeaderValue(text, name) {
      const target = name.toLowerCase()
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const parsed = splitHeaderLine(line)
        if (parsed && parsed.name.toLowerCase() === target) return parsed.value
      }
      return undefined
    }

    /** Replace (or insert) one header line, preserving every other line. */
    function writeHeaderValue(text, name, value) {
      const target = name.toLowerCase()
      const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
      const output = []
      let replaced = false
      for (const line of lines) {
        const parsed = splitHeaderLine(line)
        if (parsed && parsed.name.toLowerCase() === target) {
          if (!replaced) output.push(`${name}: ${value}`)
          replaced = true
          continue
        }
        output.push(line)
      }
      if (!replaced) output.push(`${name}: ${value}`)
      return output.join('\n')
    }

    /** The `${credential:REF}` reference a header value holds, if any. */
    function credentialRefOf(value) {
      const match = /^\$\{credential:([A-Za-z0-9_.:-]{1,64})\}$/.exec(String(value ?? '').trim())
      return match ? match[1] : undefined
    }

    /** Drop one header line (name compared case-insensitively). */
    function removeHeaderValue(text, name) {
      const target = name.toLowerCase()
      return String(text ?? '')
        .split(/\r?\n/)
        .filter((line) => {
          const parsed = splitHeaderLine(line)
          return !(parsed && parsed.name.toLowerCase() === target)
        })
        .filter((line) => line.trim() !== '')
        .join('\n')
    }

    /** Deterministic reference name for one server's auth header. */
    function credentialRefName(serverName, header) {
      const name = String(serverName ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
      const field = String(header).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
      return `MCP_${name || 'SERVER'}_${field || 'TOKEN'}`.slice(0, 64)
    }

    /** Which auth header the current text seems to use. */
    function detectAuthHeader(text) {
      for (const name of AUTH_HEADER_LIBRARY) {
        if (readHeaderValue(text, name) !== undefined) return name
      }
      return AUTH_HEADER_LIBRARY[0]
    }

    /**
     * Header lines other than the auth header. One MCP server carries exactly one
     * auth header; anything else is an advanced, optional extra.
     */
    function countOtherHeaders(text, authName) {
      const target = String(authName ?? '').toLowerCase()
      let count = 0
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const parsed = splitHeaderLine(line)
        if (!parsed) continue
        if (parsed.name.toLowerCase() === target) continue
        count += 1
      }
      return count
    }

    /** Split one argument line, honouring quotes. */
    function splitArgLine(text) {
      const args = []
      let current = ''
      let quote = ''
      let escaped = false
      for (const char of String(text ?? '')) {
        if (escaped) {
          current += char
          escaped = false
          continue
        }
        if (char === '\\' && quote !== "'") {
          escaped = true
          continue
        }
        if (quote !== '') {
          if (char === quote) quote = ''
          else current += char
          continue
        }
        if (char === '"' || char === "'") {
          quote = char
          continue
        }
        if (/\s/.test(char)) {
          if (current !== '') {
            args.push(current)
            current = ''
          }
          continue
        }
        current += char
      }
      if (current !== '') args.push(current)
      return args
    }

    /** Arguments textarea ⇄ string[]: multi-line is authoritative when it has lines. */
    function parseArgs(text) {
      const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
      if (lines.length > 1) return lines.map((line) => line.trim())
      if (lines.length === 1) {
        // A single line may still be one argument containing spaces; treat quotes
        // and whitespace as separators the way a shell command line would.
        return splitArgLine(lines[0])
      }
      return []
    }

    async function request(action, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`服务器返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!body?.ok) {
        const error = body?.error ?? {}
        const failure = new Error(error.message ?? `HTTP ${response.status}`)
        failure.code = error.code
        failure.phase = error.phase
        failure.detail = error.detail
        failure.status = response.status
        throw failure
      }
      return body.data
    }

    async function loadSnapshot() {
      const response = await fetch(API, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!body?.ok) throw new Error(body?.error?.message ?? '读取失败')
      return body.data
    }

    // ── small presentational pieces ───────────────────────────────────────────

    /**
     * Inline vector icons (Phosphor geometry, 16px box, currentColor stroke).
     *
     * No emoji as structural icons: they inherit platform emoji fonts, break the
     * stroke/weight rhythm of the shell, and read inconsistently to screen readers.
     */
    const ICON_PATHS = {
      plus: 'M12 5v14M5 12h14',
      close: 'M6 6l12 12M18 6L6 18',
      search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5.2-.8L21 21',
      key: 'M14 7a4 4 0 1 1-3.1 6.5L8 16.4V19H5v-3l4.6-4.6A4 4 0 0 1 14 7Zm1 2h.01',
      trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
      retry: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
      caret: 'M9 6l6 6-6 6',
      more: 'M6 12h.01M12 12h.01M18 12h.01',
      copy: 'M9 9h9v11H9zM6 15H4V4h11v2',
      check: 'M5 13l4 4L19 7',
      reload: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
      warning: 'M12 4l9 16H3L12 4Zm0 6v5m0 3h.01',
      eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Zm10 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
      eyeOff: 'M3 3l18 18M10.6 6.1A10.6 10.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.2 7.4A17.4 17.4 0 0 0 2 12s3.6 6 10 6a10.4 10.4 0 0 0 4-.8',
    }

    function Icon({ name, size = 16, className, title }) {
      return h(
        'svg',
        {
          className: className ? `mc-icon ${className}` : 'mc-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'aria-hidden': title ? undefined : 'true',
          role: title ? 'img' : undefined,
          focusable: 'false',
        },
        title ? h('title', null, title) : null,
        h('path', { d: ICON_PATHS[name] ?? ICON_PATHS.more }),
      )
    }

    function StateBadge({ state, label }) {
      return h(
        'span',
        { className: 'mc-badge', 'data-tone': toneOf(state) },
        h('span', { className: 'mc-dot', 'aria-hidden': 'true' }),
        label,
      )
    }

    function Field({ label, hint, full, children }) {
      return h(
        'div',
        { className: full ? 'mc-field mc-field-full' : 'mc-field' },
        h('label', { className: 'mc-label' }, label),
        children,
        hint ? h('p', { className: 'mc-hint' }, hint) : null,
      )
    }

    function Note({ kind = 'info', children }) {
      const className = kind === 'error' ? 'mc-note mc-note-error' : kind === 'ok' ? 'mc-note mc-note-ok' : 'mc-note'
      return h('p', { className, role: kind === 'error' ? 'alert' : undefined }, children)
    }

    /** One discovered tool row: raw name plus the exact public name agents see. */
    function ToolList({ tools, t }) {
      if (!tools || tools.length === 0) return h('p', { className: 'mc-hint' }, t('noTools'))
      return h(
        'ul',
        { className: 'mc-list-plain' },
        tools.map((tool) => h(
          'li',
          { key: tool.publicName ?? tool.name },
          h('code', { className: 'mc-mono' }, tool.publicName ?? tool.name),
          tool.description ? h('span', { className: 'mc-hint' }, ` · ${tool.description.slice(0, 120)}`) : null,
        )),
      )
    }

    /** Structured diagnostic block: code/phase first, then the detail object. */
    function Diagnostic({ error, t }) {
      if (!error) return null
      return h(
        'div',
        { className: 'mc-note mc-note-error' },
        h(
          'dl',
          { className: 'mc-kv' },
          h('dt', null, t('codeLabel')),
          h('dd', { className: 'mc-mono' }, `${error.code} · ${error.phase}`),
          h('dt', null, t('phaseLabel')),
          h('dd', null, error.phase),
          h('dt', null, 'message'),
          h('dd', null, error.message),
          error.detail && Object.keys(error.detail).length > 0
            ? h('dt', null, t('detailLabel'))
            : null,
          error.detail && Object.keys(error.detail).length > 0
            ? h('dd', { className: 'mc-mono' }, JSON.stringify(error.detail, null, 2))
            : null,
        ),
      )
    }

    // ── the editor ────────────────────────────────────────────────────────────

    const EMPTY_DRAFT = {
      serverName: '',
      transport: 'stdio',
      command: '',
      argsText: '',
      envText: '',
      cwd: '',
      url: '',
      headersText: '',
      timeoutMs: '',
    }

    function draftOf(server) {
      const config = server.config ?? {}
      const timeoutMs = typeof config.toolCallTimeoutMs === 'number' ? String(config.toolCallTimeoutMs) : ''
      if (config.transport === 'stdio') {
        return {
          serverName: server.serverName,
          transport: 'stdio',
          command: config.command ?? '',
          argsText: (config.args ?? []).join('\n'),
          envText: formatPairLines(config.env, '='),
          cwd: config.cwd ?? '',
          url: '',
          headersText: '',
          timeoutMs,
        }
      }
      return {
        serverName: server.serverName,
        transport: config.transport === 'sse' ? 'sse' : 'streamable-http',
        command: '',
        argsText: '',
        envText: '',
        cwd: '',
        url: config.url ?? '',
        headersText: formatPairLines(config.headers, ':'),
        timeoutMs,
      }
    }

    function draftToConfig(draft) {
      const timeout = Number(draft.timeoutMs)
      const timeoutField = Number.isFinite(timeout) && timeout >= 1000 ? { toolCallTimeoutMs: timeout } : {}
      if (draft.transport === 'stdio') {
        return {
          transport: 'stdio',
          command: draft.command.trim(),
          args: parseArgs(draft.argsText),
          env: parsePairLines(draft.envText, '='),
          cwd: draft.cwd.trim(),
          ...timeoutField,
        }
      }
      return {
        transport: draft.transport,
        url: draft.url.trim(),
        headers: parsePairLines(draft.headersText, ':'),
        ...timeoutField,
      }
    }

    /** Editable header rows ⇄ the single headersText the draft carries. */
    function headerRows(text) {
      const rows = []
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const parsed = splitHeaderLine(line)
        if (parsed) rows.push({ name: parsed.name, value: parsed.value })
      }
      return rows
    }

    function rowsToText(rows) {
      return rows
        .filter((row) => String(row.name ?? '').trim() !== '' || String(row.value ?? '').trim() !== '')
        .map((row) => `${String(row.name ?? '').trim()}: ${String(row.value ?? '').trim()}`)
        .join('\n')
    }

    /** The one-entry JSON document the JSON tab shows (Claude Desktop dialect). */
    function draftToEntry(draft) {
      const name = (draft.serverName || 'mcp').trim()
      return { [name]: draftToConfig(draft) }
    }

    /** Parse either `{ name: config }` or a bare config back into a draft. */
    function entryToDraft(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON 需要是一个对象')
      const keys = Object.keys(input)
      const first = keys[0]
      if (first !== undefined && input[first] && typeof input[first] === 'object' && !Array.isArray(input[first])) {
        return draftOf({ serverName: first, config: input[first], disabled: false })
      }
      return draftOf({ serverName: '', config: input, disabled: false })
    }

    function validateDraft(draft, t) {
      const errors = []
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(draft.serverName.trim())) errors.push(t('requiredName'))
      if (draft.transport === 'stdio' && draft.command.trim() === '') errors.push(t('requiredCommand'))
      if (draft.transport !== 'stdio' && draft.url.trim() === '') errors.push(t('requiredUrl'))
      return errors
    }

    /**
     * Add / edit dialog: a modal sheet with form and JSON tabs, an editable header
     * row list, and the pre-flight probe next to the save action.
     *
     * The credential affordance lives on the header row itself: a stored secret is
     * shown as its `${credential:REF}` reference, and a typed literal can be moved
     * into the DSH credential store with one click.
     */
    function ServerDialog({ mode, server, allowedTransports, t, onCancel, onSaved, onApplied, dataDir }) {
      const [draft, setDraft] = useState(() => (server ? draftOf(server) : { ...EMPTY_DRAFT }))
      const [tab, setTab] = useState('form')
      const [busy, setBusy] = useState('')
      const [errors, setErrors] = useState([])
      const [probe, setProbe] = useState(null)
      const [toast, setToast] = useState('')
      const [jsonText, setJsonText] = useState('')
      const [jsonError, setJsonError] = useState('')
      const [revealed, setRevealed] = useState({})
      // Rows are local state: an empty row is a legitimate editing state that the
      // serialized `headersText` cannot represent, so deriving them from the text
      // would drop a freshly added blank row.
      const [rows, setRowList] = useState(() => headerRows(draft.headersText))
      const nameRef = useRef(null)
      const patch = useCallback((next) => setDraft((current) => ({ ...current, ...next })), [])
      const commitRows = useCallback((next) => {
        setRowList(next)
        patch({ headersText: rowsToText(next) })
      }, [patch])

      useEffect(() => {
        const next = server ? draftOf(server) : { ...EMPTY_DRAFT }
        setDraft(next)
        setProbe(null)
        setErrors([])
        setToast('')
        setJsonError('')
        setJsonText(JSON.stringify(draftToEntry(next), null, 2))
        setRowList(headerRows(next.headersText))
      }, [server, mode])

      useEffect(() => {
        if (mode === 'add') nameRef.current?.focus()
      }, [mode])

      // Esc closes the sheet; a modal without a keyboard exit is a trap.
      useEffect(() => {
        const onKey = (event) => {
          if (event?.key === 'Escape') onCancel?.()
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }
        return undefined
      }, [onCancel])

      const transports = allowedTransports.length > 0 ? allowedTransports : ['stdio', 'streamable-http']

      // Field-level validation, rendered inline under each control. Save and probe
      // share it so the two paths can never disagree about what is valid.
      const fieldErrors = {
        serverName: /^[A-Za-z0-9_-]{1,32}$/.test(draft.serverName.trim()) ? '' : t('requiredName'),
        command: draft.transport === 'stdio' && draft.command.trim() === '' ? t('requiredCommand') : '',
        url: draft.transport !== 'stdio' && draft.url.trim() === '' ? t('requiredUrl') : '',
        timeoutMs: draft.timeoutMs !== '' && Number(draft.timeoutMs) < 1000 ? t('timeoutError') : '',
      }
      const firstFieldError = Object.values(fieldErrors).find(Boolean) ?? ''
      const buildPayload = useCallback(() => ({
        serverName: draft.serverName.trim(),
        // Saving always means "connect": the form has no disabled switch, so a
        // server edited here comes back enabled even if import left it stopped.
        disabled: false,
        config: draftToConfig(draft),
      }), [draft])

      const runProbe = useCallback(async () => {
        if (firstFieldError !== '') {
          setErrors([firstFieldError])
          return
        }
        setErrors([])
        setBusy('probe')
        setProbe(null)
        try {
          const result = await request('testConnection', buildPayload())
          setProbe(result)
        } catch (error) {
          setProbe({
            ok: false,
            error: {
              code: error.code ?? 'ACTION_FAILED',
              phase: error.phase ?? 'config',
              message: error.message,
              detail: error.detail,
            },
          })
        } finally {
          setBusy('')
        }
      }, [buildPayload, draft, t])

      const save = useCallback(async () => {
        if (firstFieldError !== '') {
          setErrors([firstFieldError])
          return
        }
        setErrors([])
        setBusy('save')
        setToast('')
        try {
          const payload = buildPayload()
          const result = mode === 'edit' && server
            ? await request('updateServer', { id: server.id, ...payload })
            : await request('addServer', payload)
          setToast(result?.receipt?.message ?? '')
          onSaved?.(result)
        } catch (error) {
          setErrors([`${error.code ?? 'ACTION_FAILED'} · ${error.phase ?? 'config'} · ${error.message}`])
        } finally {
          setBusy('')
        }
      }, [buildPayload, draft, mode, onSaved, server, t])

      const switchTab = useCallback((next) => {
        if (next === 'json') {
          setJsonText(JSON.stringify(draftToEntry(draft), null, 2))
          setJsonError('')
          setTab('json')
          return
        }
        try {
          const parsed = JSON.parse(jsonText)
          const nextDraft = entryToDraft(parsed)
          setDraft({ ...nextDraft })
          setRowList(headerRows(nextDraft.headersText))
          setJsonError('')
          setTab('form')
        } catch (error) {
          setJsonError(t('jsonInvalid', { message: error.message }))
        }
      }, [draft, jsonText, t])

      const applyJson = useCallback((text) => {
        setJsonText(text)
        try {
          const parsed = JSON.parse(text)
          const nextDraft = entryToDraft(parsed)
          setDraft({ ...nextDraft })
          setRowList(headerRows(nextDraft.headersText))
          setJsonError('')
        } catch (error) {
          setJsonError(t('jsonInvalid', { message: error.message }))
        }
      }, [t])

      return h(
        'div',
        { className: 'mc-overlay', role: 'presentation' },
        h(
          'section',
          {
            className: 'mc-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': mode === 'edit' ? t('dialogEdit') : t('dialogAdd'),
          },
          h(
            'header',
            { className: 'mc-dialog-head' },
            h(
              'div',
              { className: 'mc-dialog-heading' },
              h('h3', { className: 'mc-dialog-title' }, mode === 'edit' ? t('dialogEdit') : t('dialogAdd')),
              h('p', { className: 'mc-dialog-sub' }, mode === 'edit' ? t('dialogSubEdit') : t('dialogSubAdd'), dataDir ? ` ${dataDir}` : ''),
            ),
            h(
              'button',
              { type: 'button', className: 'mc-icon-btn', 'aria-label': t('dialogClose'), onClick: onCancel },
              h(Icon, { name: 'close' }),
            ),
          ),
          h(
            'div',
            { className: 'mc-tabs', role: 'tablist' },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: 'mc-tab',
                'data-active': tab === 'form' ? 'true' : undefined,
                'aria-selected': tab === 'form' ? 'true' : 'false',
                onClick: () => switchTab('form'),
              },
              t('tabForm'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: 'mc-tab',
                'data-active': tab === 'json' ? 'true' : undefined,
                'aria-selected': tab === 'json' ? 'true' : 'false',
                onClick: () => switchTab('json'),
              },
              t('tabJson'),
            ),
          ),
          h(
            'div',
            { className: 'mc-dialog-body' },
            tab === 'json'
              ? h(
                'div',
                { className: 'mc-field' },
                h('textarea', {
                  className: 'mc-textarea',
                  style: { minHeight: '260px' },
                  'aria-label': t('tabJson'),
                  spellCheck: false,
                  value: jsonText,
                  onChange: (event) => applyJson(event.target.value),
                }),
                jsonError
                  ? h('p', { className: 'mc-hint mc-err' }, jsonError)
                  : h('p', { className: 'mc-hint' }, t('jsonHint')),
              )
              : h(
                'div',
                { className: 'mc-form' },
                h(
                  'div',
                  { className: 'mc-field' },
                  h('label', { className: 'mc-label' }, t('fieldName')),
                  h('input', {
                    ref: nameRef,
                    className: 'mc-input',
                    'aria-label': t('fieldName'),
                    placeholder: t('namePlaceholder'),
                    value: draft.serverName,
                    disabled: mode === 'edit',
                    spellCheck: false,
                    autoComplete: 'off',
                    onChange: (event) => patch({ serverName: event.target.value }),
                  }),
                  fieldErrors.serverName
                    ? h('p', { className: 'mc-hint mc-err' }, fieldErrors.serverName)
                    : h('p', { className: 'mc-hint' }, mode === 'edit' && server ? t('agentNameHint', { name: server.serverName }) : t('fieldNameHint')),
                ),
                h(
                  'div',
                  { className: 'mc-field' },
                  h('label', { className: 'mc-label' }, t('fieldTransport')),
                  h(
                    'select',
                    {
                      className: 'mc-select',
                      'aria-label': t('fieldTransport'),
                      value: draft.transport,
                      onChange: (event) => patch({ transport: event.target.value }),
                    },
                    transports.map((transport) => h(
                      'option',
                      { key: transport, value: transport },
                      transport === 'stdio'
                        ? t('transportStdio')
                        : transport === 'sse' ? t('transportSse') : t('transportHttp'),
                    )),
                  ),
                ),
                h(
                  'div',
                  { className: 'mc-field' },
                  h('label', { className: 'mc-label' }, t('fieldTimeout')),
                  h('input', {
                    className: 'mc-input',
                    'aria-label': t('fieldTimeout'),
                    placeholder: '60000',
                    inputMode: 'numeric',
                    value: draft.timeoutMs,
                    onChange: (event) => patch({ timeoutMs: event.target.value.replace(/[^\d]/g, '') }),
                  }),
                  fieldErrors.timeoutMs ? h('p', { className: 'mc-hint mc-err' }, fieldErrors.timeoutMs) : h('p', { className: 'mc-hint' }, t('fieldTimeoutHint')),
                ),
                draft.transport !== 'stdio'
                  ? h(
                    'div',
                    { className: 'mc-field' },
                    h('label', { className: 'mc-label' }, t('fieldUrl')),
                    h('input', {
                      className: 'mc-input',
                      'aria-label': t('fieldUrl'),
                      placeholder: t('urlPlaceholder'),
                      value: draft.url,
                      spellCheck: false,
                      autoComplete: 'off',
                      onChange: (event) => patch({ url: event.target.value }),
                    }),
                    fieldErrors.url ? h('p', { className: 'mc-hint mc-err' }, fieldErrors.url) : h('p', { className: 'mc-hint' }, t('fieldUrlHint')),
                  )
                  : [
                    h(
                      'div',
                      { key: 'command', className: 'mc-field' },
                      h('label', { className: 'mc-label' }, t('fieldCommand')),
                      h('input', {
                        className: 'mc-input',
                        'aria-label': t('fieldCommand'),
                        value: draft.command,
                        spellCheck: false,
                        autoComplete: 'off',
                        onChange: (event) => patch({ command: event.target.value }),
                      }),
                      fieldErrors.command ? h('p', { className: 'mc-hint mc-err' }, fieldErrors.command) : h('p', { className: 'mc-hint' }, t('fieldCommandHint')),
                    ),
                    h(
                      'div',
                      { key: 'args', className: 'mc-field' },
                      h('label', { className: 'mc-label' }, t('fieldArgs')),
                      h('textarea', {
                        className: 'mc-textarea',
                        'aria-label': t('fieldArgs'),
                        value: draft.argsText,
                        spellCheck: false,
                        onChange: (event) => patch({ argsText: event.target.value }),
                      }),
                      h('p', { className: 'mc-hint' }, t('fieldArgsHint')),
                    ),
                    h(
                      'div',
                      { key: 'env', className: 'mc-field' },
                      h('label', { className: 'mc-label' }, t('fieldEnv')),
                      h('textarea', {
                        className: 'mc-textarea',
                        'aria-label': t('fieldEnv'),
                        value: draft.envText,
                        spellCheck: false,
                        onChange: (event) => patch({ envText: event.target.value }),
                      }),
                      h('p', { className: 'mc-hint' }, t('fieldEnvHint')),
                    ),
                    h(
                      'div',
                      { key: 'cwd', className: 'mc-field' },
                      h('label', { className: 'mc-label' }, t('fieldCwd')),
                      h('input', {
                        className: 'mc-input',
                        'aria-label': t('fieldCwd'),
                        value: draft.cwd,
                        spellCheck: false,
                        onChange: (event) => patch({ cwd: event.target.value }),
                      }),
                    ),
                  ],
                draft.transport !== 'stdio'
                  ? h(
                    'div',
                    { className: 'mc-field' },
                    h(
                      'div',
                      { className: 'mc-field-head' },
                      h('label', { className: 'mc-label' }, t('fieldHeaders')),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'mc-link-btn',
                          onClick: () => commitRows([...rows, { name: '', value: '' }]),
                        },
                        t('headerAdd'),
                      ),
                    ),
                    rows.map((row, index) => h(
                      'div',
                      { className: 'mc-header-row', key: `${index}-${row.name}` },
                      h('input', {
                        className: 'mc-input',
                        'aria-label': t('headerName'),
                        placeholder: t('headerName'),
                        value: row.name,
                        spellCheck: false,
                        autoComplete: 'off',
                        onChange: (event) => {
                          const next = [...rows]
                          next[index] = { ...row, name: event.target.value }
                          commitRows(next)
                        },
                      }),
                      h('input', {
                        className: 'mc-input',
                        'aria-label': t('headerValue'),
                        placeholder: t('headerValue'),
                        // Hidden by default; the eye reveals the full value.
                        type: revealed[index] ? 'text' : 'password',
                        value: row.value,
                        spellCheck: false,
                        autoComplete: 'off',
                        onChange: (event) => {
                          const next = [...rows]
                          next[index] = { ...row, value: event.target.value }
                          commitRows(next)
                        },
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'mc-icon-btn',
                          'aria-label': revealed[index] ? t('headerHide') : t('headerReveal'),
                          title: revealed[index] ? t('headerHide') : t('headerReveal'),
                          onClick: () => setRevealed((current) => ({ ...current, [index]: !current[index] })),
                        },
                        h(Icon, { name: revealed[index] ? 'eyeOff' : 'eye' }),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'mc-icon-btn',
                          'aria-label': t('headerRemove'),
                          title: t('headerRemove'),
                          onClick: () => commitRows(rows.filter((_item, i) => i !== index)),
                        },
                        h(Icon, { name: 'trash' }),
                      ),
                    )),
                  )
                  : null,
                errors.length > 0 ? h(Note, { kind: 'error' }, errors.join('；')) : null,
                toast ? h(Note, { kind: 'ok' }, toast) : null,
                probe ? h(ProbeReport, { report: probe, t }) : null,
              ),
          ),
          h(
            'footer',
            { className: 'mc-dialog-foot' },
            h(
              'button',
              { type: 'button', className: 'mc-link-btn', disabled: busy === 'probe', onClick: runProbe },
              busy === 'probe' ? t('testing') : t('testDraft'),
            ),
            h('span', { className: 'mc-toolbar-spacer' }),
            h('button', { type: 'button', className: 'mc-btn', onClick: onCancel }, t('cancel')),
            h(
              'button',
              { type: 'button', className: 'mc-btn mc-btn-primary', disabled: busy === 'save', onClick: save },
              busy === 'save' ? t('saving') : mode === 'edit' ? t('actionSave') : t('actionAdd'),
            ),
          ),
        ),
      )
    }

    /** The pre-flight probe result: positive evidence, or a structured failure. */
    function ProbeReport({ report, t }) {
      const [open, setOpen] = useState(true)
      if (report.ok === false || report.error) {
        return h(
          'div',
          { className: 'mc-note mc-note-error', role: 'alert' },
          h('strong', null, t('probeFailed')),
          report.error
            ? h(
              'dl',
              { className: 'mc-kv' },
              h('dt', null, t('codeLabel')),
              h('dd', { className: 'mc-mono' }, `${report.error.code} · ${report.error.phase}`),
              h('dt', null, 'message'),
              h('dd', null, report.error.message),
              report.error.detail && Object.keys(report.error.detail).length > 0
                ? h('dt', null, t('detailLabel'))
                : null,
              report.error.detail && Object.keys(report.error.detail).length > 0
                ? h('dd', { className: 'mc-mono' }, JSON.stringify(report.error.detail, null, 2))
                : null,
            )
            : null,
          Array.isArray(report.stderr) && report.stderr.length > 0
            ? h('pre', { className: 'mc-mono' }, report.stderr.join('\n'))
            : null,
        )
      }
      const tools = report.tools ?? []
      return h(
        'div',
        { className: 'mc-note mc-note-ok' },
        h(
          'div',
          { className: 'mc-row-inline' },
          h(
            'strong',
            null,
            t('probeOk', {
              version: report.protocolVersion ?? '?',
              transport: report.transport?.type ?? '?',
              count: tools.length,
            }),
          ),
          h(
            'button',
            { type: 'button', className: 'mc-btn mc-btn-sm', onClick: () => setOpen((value) => !value) },
            open ? t('collapse') : t('expand'),
          ),
        ),
        tools.length === 0 ? h('p', { className: 'mc-hint' }, t('probeEmptyTools')) : null,
        open
          ? h(
            'div',
            null,
            h('p', { className: 'mc-hint' }, t('probeCapabilities', {
              caps: Object.keys(report.capabilities ?? {}).join('、') || t('none'),
            })),
            h('p', { className: 'mc-hint' }, t('probeTools', {
              tools: tools.map((tool) => tool.name).join('、') || t('none'),
            })),
            h('p', { className: 'mc-hint' }, t('probeElapsed', { ms: report.elapsedMs ?? 0 })),
          )
          : null,
        Array.isArray(report.warnings) && report.warnings.length > 0
          ? h('ul', { className: 'mc-list-plain' }, report.warnings.map((line) => h('li', { key: line }, line)))
          : null,
      )
    }

    // ── one registry row ──────────────────────────────────────────────────────

    /**
     * One server row.
     *
     * Split by frequency of use: the two actions people run constantly (test,
     * edit) stay visible, the rest live behind a disclosure so six buttons do not
     * compete for attention. The row name itself is the details disclosure, so the
     * whole left side is one large target instead of a tiny chevron.
     */
    function ServerItem({ server, t, locale, busy, onAction }) {
      const [open, setOpen] = useState(false)
      const [more, setMore] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [copied, setCopied] = useState('')
      const lastSuccess = formatTime(server.lastSuccessAt, locale)
      const error = server.lastError
      const endpoint = server.config.transport === 'stdio'
        ? [server.config.command, ...(server.config.args ?? [])].join(' ')
        : server.config.url

      const copy = useCallback(async (text, kind) => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(kind)
          setTimeout(() => setCopied(''), 1500)
        } catch {
          // Clipboard may be blocked; the text stays selectable.
        }
      }, [])

      return h(
        'li',
        { className: 'mc-item', 'data-tone': toneOf(server.state), 'data-open': open ? 'true' : undefined },
        h(
          'div',
          { className: 'mc-item-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'mc-disclosure',
              'aria-expanded': open ? 'true' : 'false',
              onClick: () => setOpen((value) => !value),
            },
            h(Icon, { name: 'caret', className: open ? 'mc-icon-open' : undefined }),
            h('span', { className: 'mc-name' }, server.serverName),
          ),
          h(StateBadge, { state: server.state, label: server.stateLabel }),
          server.toolCount > 0
            ? h('span', { className: 'mc-chip' }, t('toolsCount', { count: server.toolCount }))
            : null,
          h('span', { className: 'mc-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              disabled: busy !== '',
              onClick: () => onAction('test', server),
            },
            busy === 'test' ? t('testing') : t('test'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              disabled: busy !== '',
              onClick: () => onAction('edit', server),
            },
            t('edit'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mc-icon-btn',
              'aria-label': t('moreActions'),
              'aria-expanded': more ? 'true' : 'false',
              title: t('moreActions'),
              onClick: () => {
                setMore((value) => !value)
                if (more) setConfirming(false)
              },
            },
            h(Icon, { name: 'more' }),
          ),
        ),
        h(
          'div',
          { className: 'mc-meta' },
          h('span', { className: 'mc-mono' }, endpoint ?? ''),
          server.toolCount > 0 ? ` · ${t('toolsCount', { count: server.toolCount })}` : null,
          error ? h('span', { className: 'mc-err' }, ` · ${error.code}：${error.message}`) : null,
        ),
        Array.isArray(server.notes) && server.notes.length > 0
          ? h('p', { className: 'mc-hint' }, server.notes.join('；'))
          : null,
        more
          ? h(
            'div',
            { className: 'mc-more' },
            h(
              'button',
              {
                type: 'button',
                className: 'mc-btn mc-btn-sm',
                disabled: busy !== '' || server.disabled,
                onClick: () => onAction('retry', server),
              },
              t('retry'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mc-btn mc-btn-sm',
                disabled: busy !== '',
                onClick: () => onAction(server.disabled ? 'enable' : 'disable', server),
              },
              server.disabled ? t('enable') : t('disable'),
            ),
            confirming
              ? [
                h(
                  'button',
                  {
                    key: 'confirm',
                    type: 'button',
                    className: 'mc-btn mc-btn-sm mc-btn-danger',
                    disabled: busy !== '',
                    onClick: () => onAction('remove', server),
                  },
                  t('confirmRemove'),
                ),
                h(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'mc-btn mc-btn-sm',
                    onClick: () => setConfirming(false),
                  },
                  t('cancel'),
                ),
              ]
              : h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn mc-btn-sm mc-btn-danger',
                  disabled: busy !== '',
                  onClick: () => setConfirming(true),
                },
                t('remove'),
              ),
          )
          : null,
        open
          ? h(
            'div',
            { className: 'mc-details' },
            h(
              'dl',
              { className: 'mc-kv' },
              h('dt', null, t('transportLabel')),
              h('dd', { className: 'mc-mono' }, JSON.stringify(server.transport)),
              h('dt', null, t('protocolLabel')),
              h('dd', null, server.protocolVersion ?? t('none')),
              h('dt', null, t('capabilitiesLabel')),
              h('dd', null, (server.capabilities ?? []).join('、') || t('none')),
              h('dt', null, t('serverLabel')),
              h('dd', null, server.serverInfo ? `${server.serverInfo.name ?? '?'} ${server.serverInfo.version ?? ''}` : t('none')),
              h('dt', null, t('statsLabel')),
              h('dd', null, t('statsLine', {
                attempts: server.stats.attempts,
                reconnects: server.stats.reconnects,
                calls: server.stats.toolCalls,
                errors: server.stats.toolErrors,
              })),
              h('dt', null, t('lastSuccessLabel')),
              h('dd', null, lastSuccess ? t('lastSuccess', { when: lastSuccess }) : t('never')),
              server.reconnectAt ? h('dt', null, 'reconnect') : null,
              server.reconnectAt ? h('dd', null, formatTime(server.reconnectAt, locale)) : null,
            ),
            h(
              'div',
              { className: 'mc-details-tools' },
              h('p', { className: 'mc-hint' }, t('toolsLabel')),
              h(ToolList, { tools: server.tools, t }),
              server.tools.length > 0
                ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mc-link-btn',
                    onClick: () => copy(server.tools.map((tool) => tool.publicName ?? tool.name).join('\n'), 'tools'),
                  },
                  copied === 'tools' ? t('copied') : t('copyTools'),
                )
                : null,
            ),
            h(
              'div',
              { className: 'mc-details-config' },
              h('p', { className: 'mc-hint' }, t('configLabel')),
              h('pre', { className: 'mc-pre' }, JSON.stringify(server.config, null, 2)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-link-btn',
                  onClick: () => copy(JSON.stringify(server.config, null, 2), 'config'),
                },
                copied === 'config' ? t('copied') : t('copyConfig'),
              ),
            ),
            error
              ? h(
                'div',
                null,
                h(Diagnostic, { error, t }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mc-link-btn',
                    onClick: () => copy(JSON.stringify(error, null, 2), 'diagnostic'),
                  },
                  copied === 'diagnostic' ? t('copied') : t('copyDiagnostic'),
                ),
              )
              : null,
          )
          : null,
      )
    }

    // ── import / export panels ────────────────────────────────────────────────

    function ImportPanel({ t, onDone, onClose }) {
      const [text, setText] = useState('')
      const [mode, setMode] = useState('merge')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')

      const run = useCallback(async () => {
        if (text.trim() === '') {
          setError(t('importEmpty'))
          return
        }
        setBusy(true)
        setError('')
        setResult(null)
        try {
          const data = await request('importJson', { text, mode })
          setResult(data)
          onDone?.(data)
        } catch (failure) {
          const detail = failure.detail
          if (detail && Array.isArray(detail.rejected)) {
            setResult({ ok: false, ...detail })
          } else {
            setError(`${failure.code ?? 'ACTION_FAILED'} · ${failure.phase ?? 'config'} · ${failure.message}`)
          }
        } finally {
          setBusy(false)
        }
      }, [mode, onDone, t, text])

      return h(
        'section',
        { className: 'mc-panel', 'aria-label': t('importTitle') },
        h(
          'div',
          { className: 'mc-panel-head' },
          h('h3', { className: 'mc-panel-title' }, t('importTitle')),
          h('button', { type: 'button', className: 'mc-btn mc-btn-sm', onClick: onClose }, t('close')),
        ),
        h('p', { className: 'mc-hint' }, t('importHint')),
        h('textarea', {
          className: 'mc-textarea',
          style: { minHeight: '150px' },
          value: text,
          spellCheck: false,
          placeholder: '{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}}',
          onChange: (event) => setText(event.target.value),
        }),
        h(
          'div',
          { className: 'mc-radio', role: 'radiogroup', 'aria-label': t('importMode') },
          h(
            'label',
            null,
            h('input', { type: 'radio', name: 'mc-import-mode', checked: mode === 'merge', onChange: () => setMode('merge') }),
            t('importMerge'),
          ),
          h(
            'label',
            null,
            h('input', { type: 'radio', name: 'mc-import-mode', checked: mode === 'replace', onChange: () => setMode('replace') }),
            t('importReplace'),
          ),
        ),
        error ? h(Note, { kind: 'error' }, error) : null,
        result
          ? h(
            'div',
            null,
            result.ok === false
              ? h(Note, { kind: 'error' }, t('importRejected', { count: result.rejected?.length ?? 0 }))
              : h(Note, { kind: 'ok' }, t('importDone', { message: result.receipt?.message ?? '' })),
            Array.isArray(result.accepted) && result.accepted.length > 0
              ? h('p', { className: 'mc-hint' }, t('importAccepted', { names: result.accepted.join('、') }))
              : null,
            Array.isArray(result.rejected) && result.rejected.length > 0
              ? h(
                'ul',
                { className: 'mc-list-plain' },
                result.rejected.map((row, index) => h(
                  'li',
                  { key: `${row.index}-${index}`, className: 'mc-err' },
                  t('rejectedRow', {
                    index: (row.index ?? index) + 1,
                    name: row.name ?? '—',
                    code: row.code,
                    message: row.message,
                  }),
                )),
              )
              : null,
          )
          : null,
        h(
          'div',
          { className: 'mc-footer' },
          h(
            'button',
            { type: 'button', className: 'mc-btn mc-btn-primary', disabled: busy, onClick: run },
            busy ? t('importRunning') : t('importRun'),
          ),
        ),
      )
    }

    function ExportPanel({ t, onClose }) {
      const [format, setFormat] = useState('mcpServers')
      const [text, setText] = useState('')
      const [copied, setCopied] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const run = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const data = await request('exportJson', { format })
          setText(JSON.stringify(data.document, null, 2))
        } catch (failure) {
          setError(`${failure.code ?? 'ACTION_FAILED'} · ${failure.message}`)
        } finally {
          setBusy(false)
        }
      }, [format])

      const copy = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // Clipboard can be blocked; the textarea is selectable instead.
        }
      }, [text])

      return h(
        'section',
        { className: 'mc-panel', 'aria-label': t('exportTitle') },
        h(
          'div',
          { className: 'mc-panel-head' },
          h('h3', { className: 'mc-panel-title' }, t('exportTitle')),
          h('button', { type: 'button', className: 'mc-btn mc-btn-sm', onClick: onClose }, t('close')),
        ),
        h(
          'div',
          { className: 'mc-row-inline' },
          h(
            'select',
            { className: 'mc-select', style: { maxWidth: '260px' }, value: format, onChange: (event) => setFormat(event.target.value) },
            h('option', { value: 'mcpServers' }, t('exportMcp')),
            h('option', { value: 'map' }, t('exportMap')),
            h('option', { value: 'array' }, t('exportArray')),
          ),
          h('button', { type: 'button', className: 'mc-btn', disabled: busy, onClick: run }, t('exportRun')),
          text ? h('button', { type: 'button', className: 'mc-btn', onClick: copy }, copied ? t('copied') : t('copy')) : null,
        ),
        error ? h(Note, { kind: 'error' }, error) : null,
        h('textarea', {
          className: 'mc-textarea',
          style: { minHeight: '150px' },
          value: text,
          readOnly: true,
          spellCheck: false,
          placeholder: '{"mcpServers": {}}',
        }),
      )
    }

    // ── page shell ────────────────────────────────────────────────────────────

    function ConnectorPage({ t, locale }) {
      const [snapshot, setSnapshot] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [editor, setEditor] = useState(null)
      const [panel, setPanel] = useState('')
      const [busyId, setBusyId] = useState('')
      const [toast, setToast] = useState('')
      const [probeReport, setProbeReport] = useState(null)
      const [query, setQuery] = useState('')
      const [toolsMenu, setToolsMenu] = useState(false)
      const alive = useRef(true)
      const lastFocus = useRef(null)
      const openEditor = useCallback((next) => {
        // Remember what had focus so closing the sheet returns it to the trigger.
        if (typeof document !== 'undefined') lastFocus.current = document.activeElement
        setEditor(next)
      }, [])
      const closeEditor = useCallback(() => {
        setEditor(null)
        const element = lastFocus.current
        lastFocus.current = null
        if (element && typeof element.focus === 'function') element.focus()
      }, [])

      const refresh = useCallback(async () => {
        try {
          const data = await loadSnapshot()
          if (!alive.current) return
          setSnapshot(data)
          setLoadError('')
        } catch (error) {
          if (!alive.current) return
          setLoadError(error?.message ?? String(error))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      const act = useCallback(async (action, server) => {
        setBusyId({ id: server.id, action })
        setToast('')
        setProbeReport(null)
        try {
          if (action === 'edit') {
            openEditor({ mode: 'edit', server })
            return
          }
          if (action === 'test') {
            const report = await request('testConnection', { id: server.id })
            setProbeReport({ for: server.serverName, report })
            return
          }
          if (action === 'retry') {
            const data = await request('retryServer', { id: server.id })
            setToast(data?.receipt?.message ?? '')
          }
          if (action === 'enable' || action === 'disable') {
            const data = await request('setDisabled', { id: server.id, disabled: action === 'disable' })
            setToast(data?.receipt?.message ?? '')
          }
          if (action === 'remove') {
            const data = await request('removeServer', { id: server.id })
            setToast(data?.receipt?.message ?? '')
          }
          await refresh()
        } catch (error) {
          setToast(`${error.code ?? 'ACTION_FAILED'} · ${error.phase ?? 'config'} · ${error.message}`)
        } finally {
          setBusyId(null)
        }
      }, [refresh])

      const afterSave = useCallback(async (result) => {
        setToast(result?.receipt?.message ?? '')
        const mounting = result?.server
        if (mounting) {
          // The save receipt carries the *real* mount outcome, which is a second,
          // independent fact from the pre-flight probe.
          setProbeReport({
            for: mounting.serverName,
            report: mounting.state === 'error'
              ? { ok: false, error: mounting.lastError }
              : {
                ok: true,
                protocolVersion: mounting.protocolVersion,
                transport: mounting.transport,
                tools: mounting.tools ?? [],
                capabilities: Object.fromEntries((mounting.capabilities ?? []).map((key) => [key, true])),
                elapsedMs: 0,
                warnings: mounting.notes ?? [],
              },
          })
        }
        closeEditor()
        await refresh()
      }, [closeEditor, refresh])

      const stats = snapshot?.stats
      const servers = snapshot?.servers ?? []
      const policy = snapshot?.config
      const needle = query.trim().toLowerCase()
      const visible = needle === ''
        ? servers
        : servers.filter((server) => {
          const haystack = [
            server.serverName,
            server.stateLabel,
            server.config?.url ?? '',
            server.config?.command ?? '',
            ...(server.config?.args ?? []),
            ...(server.tools ?? []).map((tool) => tool.publicName ?? tool.name),
          ].join(' ').toLowerCase()
          return haystack.includes(needle)
        })

      return h(
        'div',
        { className: 'mc-root' },
        h(
          'header',
          { className: 'mc-head' },
          h('h2', { className: 'mc-title' }, t('title')),
        ),
        stats
          ? h(
            'p',
            { className: 'mc-summary' },
            t('summary', {
              servers: stats.total,
              tools: stats.tools,
              ready: stats.ready + stats.degraded,
            }),
          )
          : null,

        h(
          'div',
          { className: 'mc-toolbar' },
          h(
            'div',
            { className: 'mc-search' },
            h(Icon, { name: 'search', className: 'mc-search-icon' }),
            h('input', {
              className: 'mc-input mc-search-input',
              type: 'search',
              'aria-label': t('search'),
              placeholder: t('searchPlaceholder'),
              value: query,
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
            }),
            query !== ''
              ? h(
                'button',
                {
                  type: 'button',
                  className: 'mc-icon-btn mc-search-clear',
                  'aria-label': t('clearSearch'),
                  onClick: () => setQuery(''),
                },
                h(Icon, { name: 'close' }),
              )
              : null,
          ),
          h('span', { className: 'mc-toolbar-spacer' }),
          h(
            'button',
            { type: 'button', className: 'mc-btn mc-btn-primary', onClick: () => openEditor({ mode: 'add' }) },
            h(Icon, { name: 'plus' }),
            t('actionAdd'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mc-icon-btn',
              'aria-label': t('moreActions'),
              'aria-expanded': toolsMenu ? 'true' : 'false',
              title: t('moreActions'),
              onClick: () => setToolsMenu((value) => !value),
            },
            h(Icon, { name: 'more' }),
          ),
        ),
        toolsMenu
          ? h(
            'div',
            { className: 'mc-more' },
            h(
              'button',
              { type: 'button', className: 'mc-btn mc-btn-sm', onClick: () => { setPanel(panel === 'import' ? '' : 'import'); setToolsMenu(false) } },
              t('import'),
            ),
            h(
              'button',
              { type: 'button', className: 'mc-btn mc-btn-sm', onClick: () => { setPanel(panel === 'export' ? '' : 'export'); setToolsMenu(false) } },
              t('export'),
            ),
            h(
              'button',
              { type: 'button', className: 'mc-btn mc-btn-sm', onClick: () => { setToolsMenu(false); refresh() } },
              t('refresh'),
            ),
          )
          : null,

        loadError ? h(Note, { kind: 'error' }, `${t('loadFailed')}${loadError}`) : null,
        !snapshot && !loadError
          ? h(
            'ul',
            { className: 'mc-list', 'aria-hidden': 'true' },
            [0, 1, 2].map((index) => h(
              'li',
              { key: index, className: 'mc-skeleton' },
              h('span', { className: 'mc-skel-line mc-skel-title' }),
              h('span', { className: 'mc-skel-line mc-skel-meta' }),
              h('span', { className: 'mc-skel-line mc-skel-meta mc-skel-short' }),
            )),
          )
          : null,

        editor
          ? h(ServerDialog, {
            key: editor.mode === 'edit' ? `edit-${editor.server.id}` : 'add',
            mode: editor.mode,
            server: editor.server,
            allowedTransports: policy?.allowedTransports ?? ['stdio', 'streamable-http'],
            t,
            onCancel: closeEditor,
            onSaved: afterSave,
            dataDir: policy?.dataDir ?? '',
            onApplied: async (result) => {
              setToast(result?.receipt?.message ?? '')
              await refresh()
            },
          })
          : null,

        panel === 'import'
          ? h(ImportPanel, { t, onDone: refresh, onClose: () => setPanel('') })
          : null,
        panel === 'export' ? h(ExportPanel, { t, onClose: () => setPanel('') }) : null,

        probeReport
          ? h(
            'section',
            { className: 'mc-panel', 'aria-label': t('test') },
            h(
              'div',
              { className: 'mc-panel-head' },
              h('h3', { className: 'mc-panel-title' }, `${t('test')} · ${probeReport.for}`),
              h('button', { type: 'button', className: 'mc-btn mc-btn-sm', onClick: () => setProbeReport(null) }, t('close')),
            ),
            h(ProbeReport, { report: probeReport.report, t }),
          )
          : null,

        toast ? h(Note, { kind: 'ok' }, toast) : null,

        servers.length === 0 && snapshot
          ? h(
            'div',
            { className: 'mc-empty' },
            h('p', { className: 'mc-intro' }, t('empty')),
            h('p', { className: 'mc-hint' }, t('emptyHint')),
          )
          : visible.length === 0
            ? h(
              'div',
              { className: 'mc-empty' },
              h('p', { className: 'mc-intro' }, t('noMatch', { query: query.trim() })),
              h(
                'button',
                { type: 'button', className: 'mc-btn mc-btn-sm', onClick: () => setQuery('') },
                t('clearSearch'),
              ),
            )
            : h(
              'ul',
              { className: 'mc-list' },
              visible.map((server) => h(ServerItem, {
                key: server.id,
                server,
                t,
                locale,
                busy: busyId?.id === server.id ? busyId.action : '',
                onAction: act,
              })),
            ),
      )
    }

    // ── registration ──────────────────────────────────────────────────────────

    return {
      inject: ['slots'],
      apply(ctx) {
        installStyles()
        const localeService = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        let t = (key, params) => {
          const template = ZH[key] ?? EN[key] ?? key
          return params
            ? template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
            : template
        }
        let locale = 'zh'
        if (localeService?.register) {
          ctx.effect(() => localeService.register(NS, { zh: ZH, en: EN }), 'mcp-connector: dictionaries')
          const bound = localeService.bind(NS)
          t = (key, params) => {
            try {
              const text = bound(key, params)
              return text === undefined ? key : text
            } catch {
              return key
            }
          }
          try {
            const snapshot = localeService.getSnapshot?.()
            locale = snapshot?.locale ?? snapshot?.language ?? 'zh'
          } catch {
            locale = 'zh'
          }
        }

        if (!ctx.slots) return
        // A top-level Settings section — same shape the installed appearance
        // plugin uses. This page is an operations console for external servers,
        // so it must be reachable from the Settings navigation itself rather than
        // only as a tab inside the built-in plugins page.
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'mcp-connector', order: 60, label: () => t('title'), locale: NS },
          function McpConnectorSettings() {
            return h(ConnectorPage, { t, locale })
          },
        ))
      },
    }
  },
})
