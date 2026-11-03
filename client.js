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
    const FEEDBACK_MS = 4500
    const POLL_MS = 3000

    // ── copy ──────────────────────────────────────────────────────────────────
    // The plugin's identity label is English — `MCP Connector`, derived from the
    // package name `@local/dsh-mcp-connector` the way DSH names its own plugins.
    // It is intentionally identical in both dictionaries: it is the product name,
    // not a translatable sentence. Everything below it stays localized.
    const ZH = {
      title: 'MCP Connector',
      summary: '{servers} 台服务器 · {ready} 就绪 · {tools} 个工具',
      refreshed: '已刷新',
      refresh: '刷新',
      search: '搜索服务器',
      searchPlaceholder: '按名称搜索…',
      filteringBy: '按「{query}」筛选：{count} 台匹配',
      clearSearch: '清除搜索',
      noMatch: '没有匹配「{query}」的服务器',
      rowActions: '该服务器操作',
      oauthAuthorize: '授权',
      oauthPendingShort: '授权中…',
      oauthRevoke: '取消授权',
      oauthPending: '等待浏览器完成授权…',
      oauthAuthorized: '已授权',
      oauthFailed: '授权失败：{message}',
      oauthUnsupported: '该服务器不支持 OAuth 授权',
      copyTools: '复制工具名',
      copyConfig: '复制配置',
      copyDiagnostic: '复制诊断',
      empty: '还没有 MCP 服务器。添加一台，或从 Claude Desktop / VS Code 的配置导入。',
      emptyHint: 'stdio 服务器需要一个命令；HTTP 服务器需要一个 Streamable HTTP 端点。',
      loadFailed: '无法读取注册表：',
      toolsCount: '{count} 个工具',
      noTools: '未发现工具',
      lastSuccess: '最近成功 {when}',
      never: '尚未成功连接',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      enable: '启用',
      disable: '禁用',
      test: '测试连接',
      retry: '重试连接',
      hintDisabled: '已停用：不会建立连接，工具对模型不可见；点「启用」即可恢复。',
      hintError: '连接失败，可点「重试连接」再试一次。',
      hintReconnecting: '连接断开，正在自动重连…',
      expand: '详情',
      collapse: '收起',
      transportLabel: '传输',
      protocolLabel: '协议版本',
      capabilitiesLabel: '服务器能力',
      serverLabel: '服务器信息',
      toolsLabel: '工具',
      statsLabel: '统计',
      lastSuccessLabel: '最近成功',
      phaseLabel: '阶段',
      codeLabel: '错误码',
      detailLabel: '细节',
      configLabel: '连接参数',
      none: '无',
      statsLine: '尝试 {attempts} · 重连 {reconnects} · 调用 {calls}（失败 {errors}）',

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
      headerMaskedValue: '请求头「{name}」的值是掩码占位符（••••），请重新输入真实值。',
      jsonOptimize: '一键优化',
      jsonOptimized: '已整理为标准格式',
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

      saving: '保存中…',
      testDraft: '测试连接',
      testing: '测试中…',
      requiredName: '必填：服务器名（1–32 位，仅限字母、数字、- 和 _）。',
      requiredCommand: '必填：启动命令（例如 npx / node）。',
      requiredUrl: '必填：服务地址（HTTP(S) 端点）。',
      transportStdio: 'stdio（本地子进程）',
      transportHttp: 'Streamable HTTP',
      transportSse: 'HTTP + SSE（旧版）',

      probeOk: '连接有效：{version} · {transport} · {count} 个工具',
      probeFailed: '连接失败',
      probeEmptyTools: '连接有效，但服务器没有暴露任何工具。',
      probeCapabilities: '能力：{caps}',
      probeTools: '工具：{tools}',
      probeElapsed: '耗时 {ms}ms',

      copied: '已复制',
      close: '关闭',
    }

    const EN = {
      title: 'MCP Connector',
      summary: '{servers} servers · {ready} ready · {tools} tools',
      refreshed: 'Refreshed',
      refresh: 'Refresh',
      search: 'Search servers',
      searchPlaceholder: 'Search by name…',
      filteringBy: 'Filtering by “{query}”: {count} matched',
      clearSearch: 'Clear search',
      noMatch: 'No server matches “{query}”',
      rowActions: 'Server actions',
      oauthAuthorize: 'Authorize',
      oauthPendingShort: 'Authorizing…',
      oauthRevoke: 'Revoke',
      oauthPending: 'Waiting for the browser to finish…',
      oauthAuthorized: 'Authorized',
      oauthFailed: 'Authorization failed: {message}',
      oauthUnsupported: 'This server does not support OAuth',
      copyTools: 'Copy tool names',
      copyConfig: 'Copy config',
      copyDiagnostic: 'Copy diagnostic',
      empty: 'No MCP servers yet. Add one, or import a Claude Desktop / VS Code config.',
      emptyHint: 'A stdio server needs a command; an HTTP server needs a Streamable HTTP endpoint.',
      loadFailed: 'Cannot read the registry: ',
      toolsCount: '{count} tools',
      noTools: 'No tools discovered',
      lastSuccess: 'Last success {when}',
      never: 'Never connected',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Delete',
      cancel: 'Cancel',
      enable: 'Enable',
      disable: 'Disable',
      test: 'Test connection',
      retry: 'Retry',
      hintDisabled: 'Disabled: not connected and its tools are hidden; press Enable to bring it back.',
      hintError: 'Connection failed; press Retry to try again.',
      hintReconnecting: 'Connection dropped; reconnecting…',
      expand: 'Details',
      collapse: 'Hide',
      transportLabel: 'Transport',
      protocolLabel: 'Protocol',
      capabilitiesLabel: 'Capabilities',
      serverLabel: 'Server',
      toolsLabel: 'Tools',
      statsLabel: 'Stats',
      lastSuccessLabel: 'Last success',
      phaseLabel: 'Phase',
      codeLabel: 'Code',
      detailLabel: 'Detail',
      configLabel: 'Connection',
      none: 'None',
      statsLine: '{attempts} attempts · {reconnects} reconnects · {calls} calls ({errors} failed)',

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
      headerMaskedValue: 'Header “{name}” still holds the mask placeholder (••••); enter the real value.',
      jsonOptimize: 'Tidy up',
      jsonOptimized: 'Formatted',
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
      saving: 'Saving…',
      testDraft: 'Test connection',
      testing: 'Testing…',
      requiredName: 'Required: 1–32 chars, letters, digits, - and _ only.',
      requiredCommand: 'Required: the command to run (e.g. npx / node).',
      requiredUrl: 'Required: the HTTP(S) endpoint.',
      transportStdio: 'stdio (local process)',
      transportHttp: 'Streamable HTTP',
      transportSse: 'HTTP + SSE (legacy)',

      probeOk: 'Reachable: {version} · {transport} · {count} tools',
      probeFailed: 'Connection failed',
      probeEmptyTools: 'Reachable, but the server exposes no tools.',
      probeCapabilities: 'Capabilities: {caps}',
      probeTools: 'Tools: {tools}',
      probeElapsed: '{ms}ms',

      copied: 'Copied',
      close: 'Close',
    }

    // ── styles ────────────────────────────────────────────────────────────────
    const CSS = [
      '.mc-root{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;',
      'color:var(--dsw-alias-label-primary)}',
      '.mc-head{display:flex;flex-direction:column;gap:4px}',
      '.mc-title{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.mc-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);text-wrap:pretty}',
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
      '.mc-btn-sm{height:26px;font-size:12px;padding:0 9px}',
      '.mc-btn:focus-visible,.mc-input:focus-visible,.mc-textarea:focus-visible,.mc-select:focus-visible',
      '{outline:var(--dsw-focus-ring-width) solid',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.mc-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
      '.mc-item{display:flex;flex-direction:column;gap:8px;padding:12px 14px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-1);transition:border-color .12s ease,background-color .12s ease}',
      '.mc-item:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mc-item[data-open="true"]{border-color:var(--dsw-alias-border-l4)}',
      '.mc-name{font-size:14px;font-weight:500;line-height:20px;word-break:break-all}',
      '.mc-meta{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
      'word-break:break-word;font-variant-numeric:tabular-nums}',
      '.mc-meta code{font:12.5px/18px ui-monospace,SFMono-Regular,monospace}',
      '.mc-err{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}',
      '.mc-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.mc-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;',
      'border-radius:999px;font-size:12px;line-height:20px;',
      'border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
      '@keyframes mc-spin{to{transform:rotate(360deg)}}',
      '.mc-spin{animation:mc-spin .8s linear infinite}',
      '.mc-refreshed{color:var(--dsw-alias-state-business-primary)}',
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
      '.mc-hint{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.mc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}',
      '.mc-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.mc-field-full{grid-column:1 / -1}',
      '.mc-label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.mc-input,.mc-select,.mc-textarea{box-sizing:border-box;width:100%;font:inherit;font-size:12.5px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:5px 8px}',
      '.mc-input,.mc-select{height:28px}',
      '.mc-textarea{min-height:58px;resize:vertical;font:12px/17px ui-monospace,SFMono-Regular,monospace}',
      '.mc-input:disabled{opacity:.6;cursor:not-allowed}',
      '.mc-row-inline{display:flex;align-items:center;gap:8px}',
      '.mc-empty{display:flex;flex-direction:column;gap:4px;padding:22px 2px;text-align:left}',
      '.mc-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12.5px;line-height:18px}',
      '.mc-kv dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.mc-kv dd{margin:0;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.mc-mono{font:12.5px/18px ui-monospace,SFMono-Regular,monospace;word-break:break-all}',
      '.mc-endpoint{font:13px/19px ui-monospace,SFMono-Regular,monospace;word-break:break-all;',
      'color:var(--dsw-alias-label-secondary)}',
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
      '.mc-summary{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      // Modal sheet for add/edit: overlay + card, tabs, header rows, footer.
      '.mc-dialog{display:flex;flex-direction:column;width:100%;max-width:660px;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md);box-shadow:0 18px 48px rgba(0,0,0,.28)}',
      '.mc-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px 8px}',
      '.mc-dialog-heading{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.mc-dialog-title{margin:0;font-size:16px;font-weight:600;line-height:24px}',
      '.mc-dialog-sub{margin:0;font-size:12.5px;line-height:18px;word-break:break-all;color:var(--dsw-alias-label-tertiary)}',
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
      '.mc-link-btn{padding:0;font:inherit;font-size:12.5px;cursor:pointer;color:var(--dsw-alias-link);background:0 0;border:0}',
      '.mc-link-btn:hover{text-decoration:underline}',
      '.mc-editor{gap:0;padding:0;overflow:visible}',
      '.mc-editor .mc-dialog-head{padding:14px 16px 8px}',
      '.mc-editor .mc-dialog-body{max-height:none;overflow:visible;padding:14px 16px}',
      '.mc-editor .mc-dialog-foot{padding:12px 16px}',
      '.mc-select-wrap{position:relative;display:inline-block;width:100%}',
      '.mc-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;',
      'height:28px;padding:0 8px;font:inherit;font-size:12.5px;cursor:pointer;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);text-align:left}',
      '.mc-select-trigger:hover{background:var(--dsw-alias-bg-layer-3)}',
      '.mc-select-trigger:focus-visible{outline:var(--dsw-focus-ring-width) solid',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.mc-select-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mc-select-caret{color:var(--dsw-alias-label-tertiary);transform:rotate(90deg)}',
      '.mc-select-caret-open{transform:rotate(270deg)}',
      '.mc-select-menu{position:absolute;z-index:59;top:calc(100% + 4px);left:0;right:0;margin:0;padding:4px;',
      'list-style:none;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md);box-shadow:0 10px 28px rgba(0,0,0,.22);max-height:220px;overflow:auto}',
      '.mc-select-option{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:6px 8px;border-radius:var(--dsw-radius-sm);font-size:12.5px;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary)}',
      '.mc-select-option.is-active{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.mc-select-option.is-selected{color:var(--dsw-alias-label-primary)}',      '.mc-header-row{display:grid;grid-template-columns:1fr 1fr auto auto;gap:6px;align-items:center;margin-top:6px}',
      '.mc-input[aria-invalid="true"],.mc-textarea[aria-invalid="true"]{',
      'border-color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.mc-input[aria-invalid="true"]:focus-visible,.mc-textarea[aria-invalid="true"]:focus-visible{',
      'outline-color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.mc-hint.mc-err{font-size:12.5px;line-height:18px}',
      '.mc-dialog-foot{display:flex;align-items:center;gap:8px;padding:12px 18px;',
      'border-top:.5px solid var(--dsw-alias-border-l2)}',
      // Icons, search, row disclosure, skeleton.
      '.mc-icon{display:block;flex:none}',
      '.mc-icon-open{transform:rotate(90deg)}',
      '.mc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px}',
      '.mc-btn-outline{width:30px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}',
      '.mc-btn-outline:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l4)}',
      '.mc-icon-btn{width:28px;height:28px}',
      '.mc-actions{display:inline-flex;align-items:center;gap:2px;padding:2px;margin-left:6px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2)}',
      '.mc-actions .mc-icon-btn{width:26px;height:26px;border-radius:999px}',
      '.mc-actions .mc-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
      '.mc-act-test{color:var(--dsw-alias-label-secondary)}',
      '.mc-act-retry{color:var(--dsw-alias-state-business-primary)}',
      '.mc-act-power{color:var(--dsw-alias-label-secondary)}',
      '.mc-act-power[data-tone="off"]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}',
      '.mc-act-edit{color:var(--dsw-alias-label-secondary)}',
      '.mc-act-power[data-tone="on"]{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}',
      '.mc-act-danger{color:var(--dsw-alias-state-error-primary)}',
      '.mc-oauth-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}',
      '.mc-tip-wrap{position:relative;display:inline-flex;flex:none}',
      '.mc-tip{position:absolute;left:50%;bottom:calc(100% + 6px);z-index:70;',
      'transform:translate(-50%,2px);opacity:0;pointer-events:none;white-space:nowrap;',
      'padding:4px 9px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:17px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);',
      'border:.5px solid var(--dsw-alias-border-l3);box-shadow:0 6px 18px rgba(0,0,0,.18);',
      'transition:opacity .12s ease,transform .12s ease;transition-delay:.18s}',
      '.mc-tip-wrap:hover>.mc-tip,.mc-tip-wrap:focus-within>.mc-tip{opacity:1;transform:translate(-50%,0)}',
      '.mc-actions .mc-tip-wrap:first-child>.mc-tip{left:0;transform:translate(0,2px)}',
      '.mc-actions .mc-tip-wrap:first-child:hover>.mc-tip{transform:translate(0,0)}',
      '.mc-actions .mc-tip-wrap:last-child>.mc-tip{left:auto;right:0;transform:translate(0,2px)}',
      '.mc-actions .mc-tip-wrap:last-child:hover>.mc-tip{transform:translate(0,0)}',

      // Hover keeps each action's colour; only the fill changes.
      '.mc-act-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-3)}',
      '.mc-act-retry:hover:not(:disabled){color:var(--dsw-alias-state-business-primary)}',
      '.mc-act-power[data-tone="on"]:hover:not(:disabled){color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}',
      '.mc-act-power[data-tone="off"]:hover:not(:disabled){color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}',
      '.mc-item .mc-note{margin:0}',
      '.mc-search{position:relative;display:flex;align-items:center;flex:1 1 220px;max-width:340px;min-width:0}',
      '.mc-search-icon{position:absolute;left:8px;color:var(--dsw-alias-label-tertiary);pointer-events:none}',
      '.mc-search-input{padding-left:28px;padding-right:28px;-webkit-appearance:none;appearance:none}',
      '.mc-search-input[data-filtering="true"]{padding-right:66px}',
      '.mc-search-input::-webkit-search-cancel-button,.mc-search-input::-ms-clear{display:none}',
      '.mc-search-clear{position:absolute;right:1px}',
      '.mc-filter-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;',
      'margin:0;padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);',
      'font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.mc-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mc-disclosure{display:inline-flex;align-items:center;gap:6px;padding:0;font:inherit;',
      'color:inherit;background:0 0;border:0;cursor:pointer;text-align:left}',
      '.mc-disclosure:focus-visible{outline:var(--dsw-focus-ring-width) solid',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px}',
      '.mc-tag-btn{display:inline-flex;align-items:center;height:22px;padding:0 9px;font:inherit;',
      'font-size:12px;line-height:20px;cursor:pointer;font-weight:500;',
      'color:var(--dsw-alias-state-business-primary);',
      'background:transparent;border:.5px solid currentColor;',
      'border-radius:999px;transition:background-color .12s ease,color .12s ease}',
      '.mc-tag-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-business-primary)}',
      '.mc-tag-btn[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}',
      '.mc-tag-btn:disabled{opacity:.55;cursor:default}',
      '.mc-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;',
      'font-size:12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
      '.mc-spacer{flex:1 1 auto}',
      '.mc-details{display:flex;flex-direction:column;gap:10px;padding:10px 12px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.mc-json{position:relative;display:block;border:.5px solid var(--dsw-alias-border-l2);',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);overflow:hidden}',
      '.mc-json .mc-json-hl{position:absolute;inset:0;margin:0;padding:10px 12px;overflow:auto;',
      'pointer-events:none;box-sizing:border-box;white-space:pre-wrap;word-break:break-all;',
      'font:12.5px/19px ui-monospace,SFMono-Regular,monospace;color:var(--dsw-alias-label-secondary)}',
      '.mc-json .mc-textarea{position:relative;z-index:1;box-sizing:border-box;display:block;',
      'width:100%;min-height:260px;margin:0;padding:10px 12px;border:0;border-radius:0;resize:vertical;',
      'background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary);',
      'font:12.5px/19px ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;word-break:break-all}',
      '.mc-json .mc-textarea:focus-visible{outline:none}',
      '.mc-json:focus-within{border-color:var(--dsw-alias-border-l4)}',
      '.mc-tok-key{color:var(--dsw-alias-state-business-primary)}',
      '.mc-tok-str{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}',
      '.mc-tok-num{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary))}',
      '.mc-tok-lit{color:var(--dsw-alias-state-error-primary)}',
      '.mc-tok-punc{color:var(--dsw-alias-label-tertiary)}',
      '.mc-pre{margin:0;max-height:220px;overflow:auto;padding:8px 10px;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);',
      'font:12px/17px ui-monospace,SFMono-Regular,monospace;color:var(--dsw-alias-label-secondary)}',
      '.mc-skeleton{display:flex;flex-direction:column;gap:8px;padding:12px 14px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-1)}',
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

    /** One line's `KEY: VALUE` split, or undefined. */
    function splitHeaderLine(line) {
      const index = line.indexOf(':')
      if (index <= 0) return undefined
      return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() }
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
      check: 'M5 13l4 4L19 7',
      reload: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
      warning: 'M12 4l9 16H3L12 4Zm0 6v5m0 3h.01',
      eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Zm10 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
      plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
      power: 'M12 3v9M6.6 6.6a8 8 0 1 0 11 0',
      pencil: 'M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4',
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

    /**
     * Icon button with a DSH-style hint bubble. A native title attribute renders
     * with OS chrome, delays for about a second and cannot be themed, so the
     * tooltip is drawn here with the same tokens as the rest of the shell.
     */
    function TipButton({ label, icon, iconClassName, className, disabled, onClick, tone }) {
      return h(
        'span',
        { className: 'mc-tip-wrap' },
        h(
          'button',
          {
            type: 'button',
            className: className ? `${className} mc-icon-btn` : 'mc-icon-btn',
            'aria-label': label,
            'data-tone': tone,
            disabled,
            onClick,
          },
          h(Icon, { name: icon, className: iconClassName }),
        ),
        h('span', { className: 'mc-tip', role: 'tooltip' }, label),
      )
    }

    /**
     * Keep a render crash visible. Without this, one bad node unmounts the whole
     * section and every control silently stops responding. The test runtime has no
     * class support, so it degrades to a pass-through there.
     */
    const Boundary = typeof React.Component === 'function'
      ? class Boundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: '' }
        }

        static getDerivedStateFromError(error) {
          return { error: error?.message ?? String(error) }
        }

        render() {
          if (this.state.error) {
            return h('p', { className: 'mc-note mc-note-error', role: 'alert' }, '界面渲染失败：' + this.state.error)
          }
          return this.props.children ?? null
        }
      }
      : (props) => props.children ?? null

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

    /** Open an external URL; a real anchor survives popup blockers. */
    function openExternal(url) {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.target = '_blank'
      anchor.rel = 'noreferrer noopener'
      if (typeof anchor.click === 'function') {
        anchor.click()
        return
      }
      if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener')
    }

    /** Split JSON text into coloured tokens for the highlight layer. */
    function jsonTokens(text) {
      const tokens = []
      const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],:])/g
      let last = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) tokens.push({ kind: 'plain', text: text.slice(last, match.index) })
        if (match[1] !== undefined) {
          tokens.push({ kind: match[2] ? 'key' : 'str', text: match[1] })
          if (match[2]) tokens.push({ kind: 'punc', text: match[2] })
        } else if (match[3] !== undefined) {
          tokens.push({ kind: 'num', text: match[3] })
        } else if (match[4] !== undefined) {
          tokens.push({ kind: 'lit', text: match[4] })
        } else if (match[5] !== undefined) {
          tokens.push({ kind: 'punc', text: match[5] })
        }
        last = pattern.lastIndex
      }
      if (last < text.length) tokens.push({ kind: 'plain', text: text.slice(last) })
      return tokens
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
      transport: 'streamable-http',
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

    /**
     * Required-field validation for the editor, as a pure function of the draft.
     * Actions re-read it from a ref, so a click can never validate a stale copy.
     */
    function validateFields(draft, t) {
      const name = String(draft.serverName ?? '').trim()
      return {
        serverName: /^[A-Za-z0-9_-]{1,32}$/.test(name) ? '' : t('requiredName'),
        command: draft.transport === 'stdio' && String(draft.command ?? '').trim() === '' ? t('requiredCommand') : '',
        url: draft.transport !== 'stdio' && String(draft.url ?? '').trim() === '' ? t('requiredUrl') : '',
        timeoutMs: draft.timeoutMs !== '' && draft.timeoutMs !== undefined && Number(draft.timeoutMs) < 1000 ? t('timeoutError') : '',
      }
    }

    function firstProblem(fields) {
      return Object.values(fields).find(Boolean) ?? ''
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
     * A picker drawn with the shell's own vocabulary: bordered trigger plus a menu.
     * A native <select> renders its option list with OS chrome, which is what made
     * the transport field look foreign next to DSH controls.
     */
    function Select({ label, value, options, onChange }) {
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(0)
      const wrapRef = useRef(null)

      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onDoc = (event) => {
          const node = wrapRef.current
          if (node && typeof node.contains === 'function' && node.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
      }, [open])

      const current = options.find((option) => option.value === value) ?? options[0]

      const choose = (next) => {
        onChange(next)
        setOpen(false)
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) {
            setOpen(true)
            setActive(Math.max(0, options.findIndex((option) => option.value === value)))
            return
          }
          const delta = event.key === 'ArrowDown' ? 1 : -1
          setActive((index) => (index + delta + options.length) % options.length)
          return
        }
        if ((event.key === 'Enter' || event.key === ' ') && open) {
          event.preventDefault()
          const option = options[active]
          if (option) choose(option.value)
        }
      }

      return h(
        'div',
        { className: 'mc-select-wrap', ref: wrapRef, onKeyDown },
        h(
          'button',
          {
            type: 'button',
            className: 'mc-select-trigger',
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': label,
            onClick: () => setOpen((state) => !state),
          },
          h('span', { className: 'mc-select-value' }, current ? current.label : ''),
          h(Icon, { name: 'caret', className: open ? 'mc-select-caret mc-select-caret-open' : 'mc-select-caret' }),
        ),
        open
          ? h(
            'ul',
            { className: 'mc-select-menu', role: 'listbox', 'aria-label': label },
            options.map((option, index) => h(
              'li',
              {
                key: option.value,
                role: 'option',
                'aria-selected': option.value === value ? 'true' : 'false',
                className: 'mc-select-option' + (index === active ? ' is-active' : '') + (option.value === value ? ' is-selected' : ''),
                onMouseEnter: () => setActive(index),
                onClick: () => choose(option.value),
              },
              h('span', null, option.label),
              option.value === value ? h(Icon, { name: 'check' }) : null,
            )),
          )
          : null,
      )
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
      const [status, setStatus] = useState('')
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
      const fieldErrors = validateFields(draft, t)
      const [attempted, setAttempted] = useState(false)
      // Stay quiet until the first submit: an untouched form should never be red.
      const shown = attempted ? fieldErrors : { serverName: '', command: '', url: '', timeoutMs: '' }
      // The handlers read the live draft from this ref, never from a closure.
      const draftRef = useRef(draft)
      draftRef.current = draft
      const buildPayload = useCallback((source = draftRef.current) => ({
        serverName: String(source.serverName ?? '').trim(),
        // Saving always means "connect": the form has no disabled switch, so a
        // server edited here comes back enabled even if import left it stopped.
        disabled: false,
        config: draftToConfig(source),
      }), [])

      const maskedHeader = (row) => /\u2022/.test(String(row.value ?? '')) || /^\*{3,}$/.test(String(row.value ?? ''))

      /**
       * In the JSON tab the editable text is the source of truth, so save/probe
       * parse it instead of validating the stale form draft. Returns the parsed
       * draft, or undefined when the text is not usable yet.
       */
      const draftFromJson = useCallback(() => {
        try {
          return entryToDraft(JSON.parse(jsonText))
        } catch (error) {
          setJsonError(t('jsonInvalid', { message: error.message }))
          return undefined
        }
      }, [jsonText, t])

      /** Pretty-print and normalise the JSON tab content. */
      const formatJson = useCallback(() => {
        try {
          const parsed = entryToDraft(JSON.parse(jsonText))
          setDraft({ ...parsed })
          setRowList(headerRows(parsed.headersText))
          setJsonText(JSON.stringify(draftToEntry(parsed), null, 2))
          setJsonError('')
          setStatus(t('jsonOptimized'))
          setTimeout(() => setStatus(''), 2000).unref?.()
        } catch (error) {
          setJsonError(t('jsonInvalid', { message: error.message }))
        }
      }, [jsonText, t])

      const runProbe = useCallback(async () => {
        setAttempted(true)
        const source = tab === 'json' ? draftFromJson() : draftRef.current
        if (!source) return
        const problems = Object.values(validateFields(source, t)).filter(Boolean)
        const masked = rows.find((row) => maskedHeader(row))
        if (masked && tab !== 'json') problems.push(t('headerMaskedValue', { name: masked.name || '?' }))
        if (problems.length > 0) {
          setErrors(problems)
          return
        }
        setErrors([])
        setStatus(t('testing'))
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
          setStatus('')
          setBusy('')
        }
      }, [buildPayload, draftFromJson, tab, t])

      const save = useCallback(async () => {
        setAttempted(true)
        const source = tab === 'json' ? draftFromJson() : draftRef.current
        if (!source) return
        const problems = Object.values(validateFields(source, t)).filter(Boolean)
        const masked = rows.find((row) => maskedHeader(row))
        if (masked && tab !== 'json') problems.push(t('headerMaskedValue', { name: masked.name || '?' }))
        if (problems.length > 0) {
          setErrors(problems)
          return
        }
        setErrors([])
        setStatus(t('saving'))
        setBusy('save')
        setToast('')
        try {
          const payload = buildPayload(source)
          const result = mode === 'edit' && server
            ? await request('updateServer', { id: server.id, ...payload })
            : await request('addServer', payload)
          setToast(result?.receipt?.message ?? '')
          onSaved?.(result)
        } catch (error) {
          setErrors([`${error.code ?? 'ACTION_FAILED'} · ${error.phase ?? 'config'} · ${error.message}`])
        } finally {
          setStatus('')
          setBusy('')
        }
      }, [buildPayload, draftFromJson, mode, onSaved, server, tab, t])

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
        'section',
        {
          className: 'mc-panel mc-editor',
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
                h(
                  'div',
                  { className: 'mc-field-head' },
                  h('label', { className: 'mc-label' }, t('tabJson')),
                  h(
                    'button',
                    { type: 'button', className: 'mc-link-btn', onClick: formatJson },
                    t('jsonOptimize'),
                  ),
                ),
                h(
                  'div',
                  { className: 'mc-json' },
                  h(
                    'pre',
                    { className: 'mc-json-hl', 'aria-hidden': 'true' },
                    jsonTokens(jsonText).map((token, index) => h(
                      'span',
                      { key: index, className: `mc-tok mc-tok-${token.kind}` },
                      token.text,
                    )),
                    '\n',
                  ),
                  h('textarea', {
                    className: 'mc-textarea',
                    'aria-label': t('tabJson'),
                    spellCheck: false,
                    value: jsonText,
                    onChange: (event) => applyJson(event.target.value),
                    onScroll: (event) => {
                      const layer = event.currentTarget?.previousSibling
                      if (layer) {
                        layer.scrollTop = event.currentTarget.scrollTop
                        layer.scrollLeft = event.currentTarget.scrollLeft
                      }
                    },
                  }),
                ),
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
                    'aria-invalid': shown.serverName ? 'true' : undefined,
                    'aria-label': t('fieldName'),
                    placeholder: t('namePlaceholder'),
                    value: draft.serverName,
                    disabled: mode === 'edit',
                    spellCheck: false,
                    autoComplete: 'off',
                    onChange: (event) => patch({ serverName: event.target.value }),
                  }),
                  shown.serverName
                    ? h('p', { className: 'mc-hint mc-err' }, shown.serverName)
                    : h('p', { className: 'mc-hint' }, mode === 'edit' && server ? t('agentNameHint', { name: server.serverName }) : t('fieldNameHint')),
                ),
                h(
                  'div',
                  { className: 'mc-field' },
                  h('label', { className: 'mc-label' }, t('fieldTransport')),
                  h(Select, {
                    label: t('fieldTransport'),
                    value: draft.transport,
                    options: transports.map((transport) => ({
                      value: transport,
                      label: transport === 'stdio'
                        ? t('transportStdio')
                        : transport === 'sse' ? t('transportSse') : t('transportHttp'),
                    })),
                    onChange: (next) => patch({ transport: next }),
                  }),
                ),
                h(
                  'div',
                  { className: 'mc-field' },
                  h('label', { className: 'mc-label' }, t('fieldTimeout')),
                  h('input', {
                    className: 'mc-input',
                    'aria-invalid': shown.timeoutMs ? 'true' : undefined,
                    'aria-label': t('fieldTimeout'),
                    placeholder: '60000',
                    inputMode: 'numeric',
                    value: draft.timeoutMs,
                    onChange: (event) => patch({ timeoutMs: event.target.value.replace(/[^\d]/g, '') }),
                  }),
                  shown.timeoutMs ? h('p', { className: 'mc-hint mc-err' }, shown.timeoutMs) : h('p', { className: 'mc-hint' }, t('fieldTimeoutHint')),
                ),
                draft.transport !== 'stdio'
                  ? h(
                    'div',
                    { className: 'mc-field' },
                    h('label', { className: 'mc-label' }, t('fieldUrl')),
                    h('input', {
                      className: 'mc-input',
                      'aria-invalid': shown.url ? 'true' : undefined,
                      'aria-label': t('fieldUrl'),
                      placeholder: t('urlPlaceholder'),
                      value: draft.url,
                      spellCheck: false,
                      autoComplete: 'off',
                      onChange: (event) => patch({ url: event.target.value }),
                    }),
                    shown.url ? h('p', { className: 'mc-hint mc-err' }, shown.url) : h('p', { className: 'mc-hint' }, t('fieldUrlHint')),
                  )
                  : [
                    h(
                      'div',
                      { key: 'command', className: 'mc-field' },
                      h('label', { className: 'mc-label' }, t('fieldCommand')),
                      h('input', {
                        className: 'mc-input',
                        'aria-invalid': shown.command ? 'true' : undefined,
                        'aria-label': t('fieldCommand'),
                        value: draft.command,
                        spellCheck: false,
                        autoComplete: 'off',
                        onChange: (event) => patch({ command: event.target.value }),
                      }),
                      shown.command ? h('p', { className: 'mc-hint mc-err' }, shown.command) : h('p', { className: 'mc-hint' }, t('fieldCommandHint')),
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
                      { className: 'mc-header-row', key: index },
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
                      h(TipButton, {
                        label: revealed[index] ? t('headerHide') : t('headerReveal'),
                        icon: revealed[index] ? 'eyeOff' : 'eye',
                        onClick: () => setRevealed((current) => ({ ...current, [index]: !current[index] })),
                      }),
                      h(TipButton, {
                        label: t('headerRemove'),
                        icon: 'trash',
                        className: 'mc-act-danger',
                        onClick: () => commitRows(rows.filter((_item, i) => i !== index)),
                      }),
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
            status ? h('span', { className: 'mc-hint', role: 'status' }, status) : null,
            h('button', { type: 'button', className: 'mc-btn', onClick: onCancel }, t('cancel')),
            h(
              'button',
              { type: 'button', className: 'mc-btn mc-btn-primary', disabled: busy === 'save', onClick: save },
              busy === 'save' ? t('saving') : mode === 'edit' ? t('actionSave') : t('actionAdd'),
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
    function ServerItem({ server, t, locale, busy, onAction, feedback }) {
      const [open, setOpen] = useState(false)
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
        {
          className: 'mc-item',
          'data-tone': toneOf(server.state),
          'data-open': open ? 'true' : undefined,
          'data-search': String(server.serverName ?? '').toLowerCase(),
        },
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
          server.config.transport !== 'stdio'
            ? h(
              'button',
              {
                type: 'button',
                className: 'mc-tag-btn',
                'data-tone': server.oauth?.authorized ? 'ok' : undefined,
                disabled: busy !== '' || server.oauth?.status === 'pending',
                title: server.oauth?.authorized ? t('oauthRevoke') : t('oauthAuthorize'),
                onClick: () => onAction(server.oauth?.authorized ? 'oauthRevoke' : 'oauth', server),
              },
              server.oauth?.status === 'pending'
                ? t('oauthPendingShort')
                : server.oauth?.authorized ? t('oauthRevoke') : t('oauthAuthorize'),
            )
            : null,
          h('span', { className: 'mc-spacer' }),
          h(
            'div',
            { className: 'mc-actions', role: 'group', 'aria-label': t('rowActions') },
            h(TipButton, {
              label: t('test'),
              icon: 'plug',
              className: 'mc-act-test',
              disabled: busy !== '',
              onClick: () => onAction('test', server),
            }),
            h(TipButton, {
              label: t('retry'),
              icon: 'retry',
              className: 'mc-act-retry',
              disabled: busy !== '' || server.disabled,
              onClick: () => onAction('retry', server),
            }),
            h(TipButton, {
              label: server.disabled ? t('enable') : t('disable'),
              icon: 'power',
              className: 'mc-act-power',
              tone: server.disabled ? 'off' : 'on',
              disabled: busy !== '',
              onClick: () => onAction(server.disabled ? 'enable' : 'disable', server),
            }),
            h(TipButton, {
              label: t('edit'),
              icon: 'pencil',
              className: 'mc-act-edit',
              disabled: busy !== '',
              onClick: () => onAction('edit', server),
            }),
            confirming
              ? [
                h(TipButton, {
                  key: 'confirm',
                  label: t('confirmRemove'),
                  icon: 'check',
                  className: 'mc-act-danger',
                  disabled: busy !== '',
                  onClick: () => onAction('remove', server),
                }),
                h(TipButton, {
                  key: 'cancel',
                  label: t('cancel'),
                  icon: 'close',
                  onClick: () => setConfirming(false),
                }),
              ]
              : h(TipButton, {
                label: t('remove'),
                icon: 'trash',
                className: 'mc-act-danger',
                disabled: busy !== '',
                onClick: () => setConfirming(true),
              }),
          ),
        ),
        h(
          'div',
          { className: 'mc-meta' },
          h('span', { className: 'mc-endpoint' }, endpoint ?? ''),
          server.toolCount > 0 ? ` · ${t('toolsCount', { count: server.toolCount })}` : null,
          error ? h('span', { className: 'mc-err' }, ` · ${error.code}：${error.message}`) : null,
        ),
        server.oauth?.status === 'pending'
          ? h('p', { className: 'mc-hint' }, t('oauthPending'))
          : server.oauth?.status === 'authorized'
            ? h('p', { className: 'mc-hint mc-oauth-ok' }, `${t('oauthAuthorized')}${server.oauth.expiresAt ? ` · ${formatTime(server.oauth.expiresAt, locale)}` : ''}`)
            : server.oauth?.status === 'error'
              ? h('p', { className: 'mc-hint mc-err' }, t('oauthFailed', { message: server.oauth.error?.message ?? '' }))
              : null,
        server.disabled
          ? h('p', { className: 'mc-hint' }, t('hintDisabled'))
          : server.state === 'error'
            ? h('p', { className: 'mc-hint mc-err' }, t('hintError'))
            : server.state === 'reconnecting'
              ? h('p', { className: 'mc-hint' }, t('hintReconnecting'))
              : null,
        feedback
          ? h(Note, { kind: feedback.kind }, feedback.message)
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

    // ── page shell ────────────────────────────────────────────────────────────

    function ConnectorPage({ t, locale }) {
      const [snapshot, setSnapshot] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [editor, setEditor] = useState(null)
      const [busyId, setBusyId] = useState('')
      const [toast, setToast] = useState('')
      const [probeReport, setProbeReport] = useState(null)
      const [query, setQuery] = useState('')
      const [refreshing, setRefreshing] = useState(false)
      const [refreshNote, setRefreshNote] = useState('')
      const [feedback, setFeedback] = useState({})
      const feedbackTimers = useRef(new Map())
      const searchRef = useRef(null)
      const listRef = useRef(null)
      const filterBarRef = useRef(null)
      const filterTextRef = useRef(null)
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
          for (const pending of feedbackTimers.current.values()) clearTimeout(pending)
          feedbackTimers.current.clear()
        }
      }, [refresh])

      /**
       * Show a receipt on one card and retire it on its own. Timers are unref'd so a
       * pending dismissal never holds the process open, and per-id bookkeeping keeps
       * a second action from being cleared by the first action's timer.
       */
      const showFeedback = useCallback((id, note) => {
        setFeedback((current) => ({ ...current, [id]: note }))
        const timers = feedbackTimers.current
        const existing = timers.get(id)
        if (existing) clearTimeout(existing)
        if (!note) {
          timers.delete(id)
          return
        }
        const timer = setTimeout(() => {
          timers.delete(id)
          setFeedback((current) => ({ ...current, [id]: undefined }))
        }, FEEDBACK_MS)
        timer.unref?.()
        timers.set(id, timer)
      }, [])

      /**
       * Name filter applied straight to the DOM. React state filtering above still
       * drives the count, but this path cannot be broken by a missed re-render: it
       * hides cards by their `data-search` text as the user types.
       */
      const applyNameFilter = useCallback(() => {
        const input = searchRef.current
        const list = listRef.current
        if (!input || !list || typeof list.querySelectorAll !== 'function') return
        const needle = String(input.value ?? '').trim().toLowerCase()
        let shown = 0
        for (const item of list.querySelectorAll('[data-search]')) {
          const hit = needle === '' || String(item.getAttribute('data-search') ?? '').includes(needle)
          item.style.display = hit ? '' : 'none'
          if (hit) shown += 1
        }
        const bar = filterBarRef.current
        const text = filterTextRef.current
        if (bar && text) {
          if (needle === '') {
            bar.style.display = 'none'
          } else {
            bar.style.display = 'flex'
            text.textContent = t('filteringBy', { query: needle, count: shown })
          }
        }
      }, [t])

      // Re-apply after every render so a poll refresh cannot un-hide cards.
      useEffect(() => {
        applyNameFilter()
      })

      useEffect(() => {
        const node = searchRef.current
        if (!node || typeof node.addEventListener !== 'function') return undefined
        const apply = () => setQuery(node.value)
        const applyBoth = () => {
          apply()
          applyNameFilter()
        }
        node.addEventListener('input', applyBoth)
        node.addEventListener('compositionend', applyBoth)
        return () => {
          node.removeEventListener('input', applyBoth)
          node.removeEventListener('compositionend', applyBoth)
        }
      }, [applyNameFilter])

      const refreshNow = useCallback(async () => {
        setRefreshing(true)
        setRefreshNote('')
        try {
          await refresh()
          setRefreshNote(t('refreshed'))
          setTimeout(() => setRefreshNote(''), 2200).unref?.()
        } finally {
          setRefreshing(false)
        }
      }, [refresh, t])

      const act = useCallback(async (action, server) => {
        setBusyId({ id: server.id, action })
        setToast('')
        setProbeReport(null)
        // Per-card receipt: the result of an action belongs to the card it was run
        // on, not to a page-level banner the user has to associate back to a row.
        showFeedback(server.id, undefined)
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
          let message = ''
          if (action === 'retry') {
            const data = await request('retryServer', { id: server.id })
            message = data?.receipt?.message ?? ''
          }
          if (action === 'enable' || action === 'disable') {
            const data = await request('setDisabled', { id: server.id, disabled: action === 'disable' })
            message = data?.receipt?.message ?? ''
          }
          if (action === 'oauth') {
            const data = await request('oauthBegin', { id: server.id })
            if (data?.url) openExternal(data.url)
            setFeedback((current) => ({ ...current, [server.id]: { kind: 'ok', message: t('oauthPending') } }))
            await refresh()
            return
          }
          if (action === 'oauthRevoke') {
            const data = await request('oauthRevoke', { id: server.id })
            setFeedback((current) => ({ ...current, [server.id]: { kind: 'ok', message: data?.receipt?.message ?? t('oauthRevoke') } }))
            await refresh()
            return
          }
          if (action === 'remove') {
            const data = await request('removeServer', { id: server.id })
            // The card disappears, so a removed row reports on the page instead.
            setToast(data?.receipt?.message ?? '')
            await refresh()
            return
          }
          showFeedback(server.id, { kind: 'ok', message })
          await refresh()
        } catch (error) {
          const message = `${error.code ?? 'ACTION_FAILED'} · ${error.phase ?? 'config'} · ${error.message}`
          showFeedback(server.id, { kind: 'error', message })
        } finally {
          setBusyId(null)
        }
      }, [refresh, showFeedback])

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
        if (result?.receipt?.id) {
          showFeedback(result.receipt.id, { kind: 'ok', message: result.receipt.message ?? '' })
        }
        closeEditor()
        await refresh()
      }, [closeEditor, refresh, showFeedback])

      const stats = snapshot?.stats
      const servers = snapshot?.servers ?? []
      const policy = snapshot?.config
      const needle = query.trim().toLowerCase()
      const visible = needle === ''
        ? servers
        : servers.filter((server) => String(server.serverName ?? '').toLowerCase().includes(needle))

      return h(
        'div',
        { className: 'mc-root' },
        h(
          'header',
          { className: 'mc-head' },
          h('h2', { className: 'mc-title' }, t('title')),
        ),
        stats || refreshNote
          ? h(
            'p',
            { className: 'mc-summary' },
            stats
              ? t('summary', {
                servers: stats.total,
                tools: stats.tools,
                ready: stats.ready + stats.degraded,
              })
              : null,
            refreshNote ? h('span', { className: 'mc-refreshed' }, ` · ${refreshNote}`) : null,
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
              ref: searchRef,
              className: 'mc-input mc-search-input',
              type: 'text',
              'aria-label': t('search'),
              placeholder: t('searchPlaceholder'),
              value: query,
              'data-filtering': query !== '' ? 'true' : undefined,
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
              onInput: (event) => setQuery(event.currentTarget.value),
              onCompositionEnd: (event) => setQuery(event.currentTarget.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setQuery('')
                }
              },
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
          h(TipButton, {
            label: t('refresh'),
            icon: 'reload',
            iconClassName: refreshing ? 'mc-spin' : undefined,
            className: 'mc-btn-outline',
            disabled: refreshing,
            onClick: refreshNow,
          }),
          h(
            'button',
            { type: 'button', className: 'mc-btn mc-btn-primary', onClick: () => openEditor({ mode: 'add' }) },
            h(Icon, { name: 'plus' }),
            t('actionAdd'),
          ),
        ),

        h(
          'div',
          { className: 'mc-filter-bar', ref: filterBarRef, style: { display: 'none' } },
          h('span', { ref: filterTextRef }),
          h(
            'button',
            {
              type: 'button',
              className: 'mc-link-btn',
              onClick: () => {
                if (searchRef.current) searchRef.current.value = ''
                setQuery('')
                applyNameFilter()
              },
            },
            t('clearSearch'),
          ),
        ),

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
              { className: 'mc-list', ref: listRef },
              visible.map((server) => h(ServerItem, {
                key: server.id,
                server,
                t,
                locale,
                busy: busyId?.id === server.id ? busyId.action : '',
                onAction: act,
                feedback: feedback[server.id],
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
            return h(Boundary, null, h(ConnectorPage, { t, locale }))
          },
        ))
      },
    }
  },
})
