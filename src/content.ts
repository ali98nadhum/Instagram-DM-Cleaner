/*
 * Instagram Message Cleaner — core engine + UI.
 *
 * Runs entirely inside the browser tab on instagram.com/direct/*. It never
 * touches your password, never talks to any server other than instagram.com,
 * and stores nothing outside this page's memory. Auth is whatever session
 * cookies your browser already has from being logged into Instagram.
 *
 * Instagram's web client talks to its DM backend via GraphQL (doc_id-based
 * persisted queries), not the old direct_v2 REST endpoints. This file
 * mirrors that real, current approach:
 *   - x-ig-app-id is captured passively by intercepting Instagram's own
 *     window.fetch calls (it isn't a fixed constant).
 *   - fb_dtsg / lsd are Facebook-stack anti-CSRF tokens embedded in the
 *     page's inline <script> tags.
 *   - thread_fbid (used to query messages) and the thread's numeric id
 *     (used to unsend) are also read out of inline page scripts, not the URL.
 * None of this is documented or guaranteed by Instagram; if they rotate the
 * doc_id values or change how these tokens are embedded, requests will
 * start failing and the log panel will show the HTTP status/body so it can
 * be diagnosed and updated.
 *
 * This TypeScript file is the canonical source. `npm run build` type-checks
 * and compiles it to dist/content.js, then scripts/build-userscript.js
 * prepends the Tampermonkey metadata header to produce
 * userscript/instagram-message-cleaner.user.js.
 */
(function () {
  'use strict';

  const GRAPHQL_URL = 'https://www.instagram.com/api/graphql';
  const DOC_ID_MESSAGES = '26252548844395561'; // IGDMessageListOffMsysQuery
  const DOC_ID_UNSEND = '24812777031749983'; // IGDMessageUnsendDialogOffMsysMutation

  const BASE_DELETE_DELAY_MS = 3500;
  const MAX_DELETE_DELAY_MS = 15000;
  const DELETE_JITTER_MS = 500;
  const FETCH_DELAY_MS = 2000;
  const MAX_RETRIES = 3;

  // -------------------------------------------------------------------
  // types
  // -------------------------------------------------------------------
  interface IGMessage {
    message_id: string;
    sender_id: string;
    timestamp_ms: number;
    message?: { text: string };
    __typename: string;
  }

  interface IGPageInfo {
    has_previous_page: boolean;
    end_cursor: string | null;
  }

  interface AuthCredentials {
    csrfToken: string;
    userId: string;
    appId: string;
    fbDtsg: string;
    lsd: string;
  }

  type AuthResult = { ok: true; auth: AuthCredentials } | { ok: false; reason: string };

  interface ThreadInfo {
    threadFbid: string;
    threadIgid: string;
  }

  interface UnsendResult {
    status: number;
    retryAfter?: number;
  }

  type FlowError =
    | { kind: 'network'; error: unknown }
    | { kind: 'session'; status: number }
    | { kind: 'http'; status: number; body?: string };

  interface AppState {
    currentUserId: string | null;
    csrfToken: string | null;
    appId: string | null;
    myMessages: IGMessage[];
    totalCount: number;
    scanning: boolean;
    unsending: boolean;
    stopRequested: boolean;
  }

  interface PanelElements {
    body: HTMLElement;
    close: HTMLButtonElement;
    statusDot: HTMLElement;
    statusText: HTMLElement;
    thread: HTMLElement;
    total: HTMLElement;
    mine: HTMLElement;
    btnScan: HTMLButtonElement;
    btnUnsend: HTMLButtonElement;
    btnStop: HTMLButtonElement;
    confirmBox: HTMLElement;
    confirmText: HTMLElement;
    previewList: HTMLElement;
    btnConfirm: HTMLButtonElement;
    btnCancel: HTMLButtonElement;
    progressInner: HTMLElement;
    log: HTMLElement;
  }

  const state: AppState = {
    currentUserId: null,
    csrfToken: null,
    appId: null,
    myMessages: [],
    totalCount: 0,
    scanning: false,
    unsending: false,
    stopRequested: false,
  };

  let els: PanelElements;

  // -------------------------------------------------------------------
  // utils
  // -------------------------------------------------------------------
  function getCookie(name: string): string | null {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitteredDelay(base: number, jitter: number): number {
    return base + Math.floor(Math.random() * jitter * 2) - jitter;
  }

  function getUrlThreadId(): string | null {
    const m = window.location.pathname.match(/\/direct\/t\/(\d+)/);
    return m ? m[1] : null;
  }

  function nowStamp(): string {
    return new Date().toTimeString().slice(0, 8);
  }

  function inlineScripts(): NodeListOf<HTMLScriptElement> {
    return document.querySelectorAll('script:not([src])');
  }

  function itemPreviewText(msg: IGMessage): string {
    if (msg.message && msg.message.text) {
      return msg.message.text.length > 40 ? msg.message.text.slice(0, 40) + '…' : msg.message.text;
    }
    return `[${msg.__typename || 'message'}]`;
  }

  // -------------------------------------------------------------------
  // App ID interception (Instagram doesn't expose this as a static value)
  // -------------------------------------------------------------------
  function installAppIdInterceptor(): void {
    const w = window as unknown as { __imcInterceptorInstalled?: boolean };
    if (w.__imcInterceptorInstalled) return;
    w.__imcInterceptorInstalled = true;

    const originalFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (!state.appId) {
        const fromInit = extractAppIdFromHeaders(init && init.headers);
        if (fromInit) state.appId = fromInit;
        if (!state.appId && input instanceof Request) {
          const fromReq = input.headers.get('x-ig-app-id');
          if (fromReq) state.appId = fromReq;
        }
      }
      return originalFetch.call(window, input, init);
    };
  }

  function extractAppIdFromHeaders(headers: HeadersInit | undefined): string | null {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get('x-ig-app-id');
    if (Array.isArray(headers)) {
      const entry = headers.find(([key]) => key.toLowerCase() === 'x-ig-app-id');
      return entry ? entry[1] : null;
    }
    if (typeof headers === 'object') {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'x-ig-app-id') return (headers as Record<string, string>)[key];
      }
    }
    return null;
  }

  function tryExtractAppIdFromPage(): boolean {
    if (state.appId) return true;
    const appIdPattern = /["']X-IG-App-ID["']\s*:\s*["'](\d{10,20})["']/i;
    const altPattern = /instagramWebDesktopFBAppId["']\s*:\s*["'](\d{10,20})["']/;
    const altPattern2 = /app_id["']\s*:\s*["'](\d{10,20})["']/;
    for (const script of inlineScripts()) {
      const text = script.textContent || '';
      for (const pattern of [appIdPattern, altPattern, altPattern2]) {
        const match = text.match(pattern);
        if (match) {
          state.appId = match[1];
          return true;
        }
      }
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Auth token extraction (fb_dtsg / lsd / thread info live in inline scripts)
  // -------------------------------------------------------------------
  function getFbDtsg(): string | null {
    for (const script of inlineScripts()) {
      const text = script.textContent || '';
      const match = text.match(/["']token["']\s*:\s*["'](NAf[^"']+)["']/);
      if (match) return match[1];
    }
    try {
      const eqmc = (window as unknown as { __eqmc?: { f?: string } }).__eqmc;
      if (eqmc && eqmc.f) return eqmc.f;
    } catch (e) { /* ignore */ }
    try {
      const req = (window as unknown as { require?: (name: string) => any }).require;
      if (typeof req === 'function') {
        const dtsg = req('DTSGInitData') || req('DTSGInitialData');
        if (dtsg && dtsg.token) return dtsg.token;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function getLsd(): string | null {
    const meta = document.querySelector('meta[name="lsd"]');
    if (meta) return meta.getAttribute('content');
    for (const script of inlineScripts()) {
      const text = script.textContent || '';
      const match = text.match(/["']LSD["']\s*,\s*\[\]\s*,\s*\{["']token["']\s*:\s*["']([^"']+)["']/);
      if (match) return match[1];
    }
    return null;
  }

  function getAuth(): AuthResult {
    const csrfToken = getCookie('csrftoken');
    if (!csrfToken) return { ok: false, reason: 'Not logged in. Please log in to Instagram.' };
    const userId = getCookie('ds_user_id');
    if (!userId) return { ok: false, reason: 'Not logged in. Please log in to Instagram.' };
    if (!state.appId) tryExtractAppIdFromPage();
    if (!state.appId) {
      return { ok: false, reason: 'App ID not captured yet. Switch to another chat and back, then try again.' };
    }
    const fbDtsg = getFbDtsg();
    if (!fbDtsg) return { ok: false, reason: 'Could not find fb_dtsg token. Please refresh the page.' };
    const lsd = getLsd();
    if (!lsd) return { ok: false, reason: 'Could not find LSD token. Please refresh the page.' };
    return { ok: true, auth: { csrfToken, userId, appId: state.appId, fbDtsg, lsd } };
  }

  function getThreadInfo(): ThreadInfo | null {
    for (const script of inlineScripts()) {
      const text = script.textContent || '';
      const igidMatch = text.match(/"thread_igid"\s*:\s*"(\d{10,})"/);
      const fbidMatch = text.match(/"thread_fbid"\s*:\s*"(\d+)"/);
      if (igidMatch && fbidMatch) {
        return { threadFbid: fbidMatch[1], threadIgid: igidMatch[1] };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------
  // Instagram GraphQL API
  // -------------------------------------------------------------------
  function buildBody(auth: AuthCredentials, friendlyName: string, docId: string, variables: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    params.set('__d', 'www');
    params.set('__user', '0');
    params.set('__a', '1');
    params.set('fb_dtsg', auth.fbDtsg);
    params.set('lsd', auth.lsd);
    params.set('fb_api_caller_class', 'RelayModern');
    params.set('fb_api_req_friendly_name', friendlyName);
    params.set('server_timestamps', 'true');
    params.set('variables', JSON.stringify(variables));
    params.set('doc_id', docId);
    return params;
  }

  function buildHeaders(auth: AuthCredentials, friendlyName: string): Record<string, string> {
    return {
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrftoken': auth.csrfToken,
      'x-fb-friendly-name': friendlyName,
      'x-fb-lsd': auth.lsd,
      'x-ig-app-id': auth.appId,
    };
  }

  interface FetchMessagesResult {
    messages: IGMessage[];
    pageInfo: IGPageInfo;
  }

  async function fetchThreadMessages(threadFbid: string, cursor: string | null, auth: AuthCredentials): Promise<FetchMessagesResult> {
    const friendlyName = 'IGDMessageListOffMsysQuery';
    const variables: Record<string, unknown> = {
      id: threadFbid,
      first: 20,
      after: cursor,
      before: null,
      last: null,
      newer_than_message_id: null,
      older_than_message_id: null,
      __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20,
      __relay_internal__pv__IGDEnableOffMsysPinnedMessagesQErelayprovider: false,
    };

    let resp: Response;
    try {
      resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: buildHeaders(auth, friendlyName),
        body: buildBody(auth, friendlyName, DOC_ID_MESSAGES, variables),
        credentials: 'include',
      });
    } catch (error) {
      throw { kind: 'network', error } as FlowError;
    }

    if (resp.status === 401 || resp.status === 403) throw { kind: 'session', status: resp.status } as FlowError;
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw { kind: 'http', status: resp.status, body } as FlowError;
    }

    const json = await resp.json();
    const slideThread = json && json.data && json.data.fetch__SlideThread && json.data.fetch__SlideThread.as_ig_direct_thread;
    const conn = slideThread && slideThread.slide_messages;
    if (!conn || !conn.edges) {
      return { messages: [], pageInfo: { has_previous_page: false, end_cursor: null } };
    }

    const messages: IGMessage[] = conn.edges.map((edge: any) => {
      const msg = edge.node;
      let text: string | undefined;
      if (msg.content && msg.content.__typename === 'SlideMessageText') {
        text = msg.text_body || (msg.content && msg.content.text_body);
      } else if (msg.content && msg.content.xma && msg.content.xma.xmaTitle) {
        text = msg.content.xma.xmaTitle;
      }
      return {
        message_id: msg.message_id,
        sender_id: String((msg.sender && msg.sender.igid) || msg.sender_fbid || ''),
        timestamp_ms: typeof msg.timestamp_ms === 'string' ? parseInt(msg.timestamp_ms, 10) : (msg.timestamp_ms || 0),
        message: text ? { text } : undefined,
        __typename: (msg.content && msg.content.__typename) || 'unknown',
      };
    });

    const pageInfo: IGPageInfo = conn.page_info || { has_previous_page: false, end_cursor: null };
    return { messages, pageInfo };
  }

  async function unsendMessageApi(threadIgid: string, messageId: string, auth: AuthCredentials): Promise<UnsendResult> {
    const friendlyName = 'IGDMessageUnsendDialogOffMsysMutation';
    const variables = { message_id: messageId, send_data: { thread_id: threadIgid } };

    let resp: Response;
    try {
      resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: buildHeaders(auth, friendlyName),
        body: buildBody(auth, friendlyName, DOC_ID_UNSEND, variables),
        credentials: 'include',
      });
    } catch (error) {
      throw { kind: 'network', error } as FlowError;
    }

    if (resp.status === 429) {
      let retryAfter: number | undefined;
      try {
        const body = await resp.json();
        retryAfter = body.retry_after;
      } catch (e) { /* ignore */ }
      return { status: 429, retryAfter };
    }
    return { status: resp.status };
  }

  // -------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------
  function injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #imc-panel { position: fixed; top: 70px; right: 20px; width: 300px; background: #fff; border: 1px solid #dbdbdb; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); z-index: 999999; font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 13px; color: #262626; }
      #imc-panel * { box-sizing: border-box; }
      #imc-header { display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid #efefef; font-weight:600; cursor:move; user-select:none; }
      #imc-close { cursor:pointer; border:none; background:none; font-size:16px; color:#8e8e8e; }
      #imc-body { padding:12px; }
      #imc-body.imc-collapsed { display:none; }
      .imc-row { margin-bottom:8px; }
      .imc-label { color:#8e8e8e; }
      .imc-status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; }
      .imc-dot-ok { background:#2ecc71; }
      .imc-dot-bad { background:#e74c3c; }
      #imc-btn-scan, #imc-btn-unsend, #imc-btn-stop, #imc-btn-confirm, #imc-btn-cancel {
        width:100%; padding:8px; margin-top:6px; border-radius:8px; border:none; font-weight:600; cursor:pointer; font-size:13px;
      }
      #imc-btn-scan { background:#0095f6; color:#fff; }
      #imc-btn-unsend { background:#ed4956; color:#fff; }
      #imc-btn-stop { background:#efefef; color:#262626; }
      #imc-btn-confirm { background:#ed4956; color:#fff; }
      #imc-btn-cancel { background:#efefef; color:#262626; }
      button:disabled { opacity:0.5; cursor:not-allowed; }
      #imc-progress-outer { width:100%; height:8px; background:#efefef; border-radius:4px; overflow:hidden; margin-top:8px; }
      #imc-progress-inner { height:100%; width:0%; background:#0095f6; transition:width .2s; }
      #imc-log { margin-top:8px; height:110px; overflow-y:auto; background:#fafafa; border:1px solid #efefef; border-radius:6px; padding:6px; font-family: monospace; font-size:11px; line-height:1.4; }
      #imc-confirm { display:none; margin-top:8px; padding:8px; background:#fff5f5; border:1px solid #ffd6d6; border-radius:8px; }
      #imc-preview-list { max-height:90px; overflow-y:auto; font-size:11px; margin:6px 0; color:#444; }
    `;
    document.head.appendChild(style);
  }

  function injectPanel(): void {
    if (document.getElementById('imc-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'imc-panel';
    panel.innerHTML = `
      <div id="imc-header">
        <span>Instagram Message Cleaner</span>
        <button id="imc-close" title="Minimize">—</button>
      </div>
      <div id="imc-body">
        <div class="imc-row"><span class="imc-status-dot imc-dot-bad" id="imc-status-dot"></span><span id="imc-status-text">Not connected</span></div>
        <div class="imc-row"><span class="imc-label">Conversation:</span> <span id="imc-thread">—</span></div>
        <div class="imc-row"><span class="imc-label">Messages:</span> <span id="imc-total">0</span> &nbsp; <span class="imc-label">Your messages:</span> <span id="imc-mine">0</span></div>
        <button id="imc-btn-scan">Scan Messages</button>
        <button id="imc-btn-unsend" disabled>Unsend My Messages</button>
        <button id="imc-btn-stop" style="display:none;">Stop</button>
        <div id="imc-confirm">
          <div id="imc-confirm-text"></div>
          <div id="imc-preview-list"></div>
          <button id="imc-btn-confirm">Confirm Delete</button>
          <button id="imc-btn-cancel">Cancel</button>
        </div>
        <div id="imc-progress-outer"><div id="imc-progress-inner"></div></div>
        <div id="imc-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    els = {
      body: panel.querySelector('#imc-body') as HTMLElement,
      close: panel.querySelector('#imc-close') as HTMLButtonElement,
      statusDot: panel.querySelector('#imc-status-dot') as HTMLElement,
      statusText: panel.querySelector('#imc-status-text') as HTMLElement,
      thread: panel.querySelector('#imc-thread') as HTMLElement,
      total: panel.querySelector('#imc-total') as HTMLElement,
      mine: panel.querySelector('#imc-mine') as HTMLElement,
      btnScan: panel.querySelector('#imc-btn-scan') as HTMLButtonElement,
      btnUnsend: panel.querySelector('#imc-btn-unsend') as HTMLButtonElement,
      btnStop: panel.querySelector('#imc-btn-stop') as HTMLButtonElement,
      confirmBox: panel.querySelector('#imc-confirm') as HTMLElement,
      confirmText: panel.querySelector('#imc-confirm-text') as HTMLElement,
      previewList: panel.querySelector('#imc-preview-list') as HTMLElement,
      btnConfirm: panel.querySelector('#imc-btn-confirm') as HTMLButtonElement,
      btnCancel: panel.querySelector('#imc-btn-cancel') as HTMLButtonElement,
      progressInner: panel.querySelector('#imc-progress-inner') as HTMLElement,
      log: panel.querySelector('#imc-log') as HTMLElement,
    };

    els.close.addEventListener('click', () => els.body.classList.toggle('imc-collapsed'));
    els.btnScan.addEventListener('click', onScanClick);
    els.btnUnsend.addEventListener('click', onUnsendClick);
    els.btnStop.addEventListener('click', onStopClick);
    els.btnConfirm.addEventListener('click', onConfirmUnsend);
    els.btnCancel.addEventListener('click', () => { els.confirmBox.style.display = 'none'; });

    makeDraggable(panel, panel.querySelector('#imc-header') as HTMLElement);
  }

  function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
    let dragging = false, offX = 0, offY = 0;
    handle.addEventListener('mousedown', (e: MouseEvent) => {
      dragging = true;
      offX = e.clientX - panel.offsetLeft;
      offY = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - offX) + 'px';
      panel.style.top = (e.clientY - offY) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function log(msg: string, level?: 'error' | 'warn'): void {
    if (!els || !els.log) return;
    const line = document.createElement('div');
    if (level === 'error') line.style.color = '#e74c3c';
    if (level === 'warn') line.style.color = '#e6a23c';
    line.textContent = `[${nowStamp()}] ${msg}`;
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function setProgress(pct: number): void {
    els.progressInner.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function setStatus(connected: boolean, text: string): void {
    els.statusDot.className = 'imc-status-dot ' + (connected ? 'imc-dot-ok' : 'imc-dot-bad');
    els.statusText.textContent = text;
  }

  function setBusy(busy: boolean): void {
    els.btnScan.disabled = busy;
    els.btnUnsend.disabled = busy || state.myMessages.length === 0;
    els.btnStop.style.display = busy ? 'block' : 'none';
  }

  // -------------------------------------------------------------------
  // flows
  // -------------------------------------------------------------------
  async function scanMessages(): Promise<void> {
    const urlThreadId = getUrlThreadId();
    if (!urlThreadId) { log('Navigate to a DM conversation first.', 'error'); return; }

    const authResult = getAuth();
    if (!authResult.ok) { log(authResult.reason, 'error'); return; }
    const auth = authResult.auth;

    const threadInfo = getThreadInfo();
    if (!threadInfo) { log('Could not extract thread info from page. Try refreshing.', 'error'); return; }

    state.scanning = true;
    state.stopRequested = false;
    setBusy(true);
    state.myMessages = [];
    state.totalCount = 0;
    els.total.textContent = '0';
    els.mine.textContent = '0';
    setProgress(0);
    log('Scanning conversation...');

    let cursor: string | null = null;
    try {
      while (!state.stopRequested) {
        const page = await fetchThreadMessages(threadInfo.threadFbid, cursor, auth);
        const messages = page.messages || [];
        if (messages.length === 0) break;

        state.totalCount += messages.length;
        for (const msg of messages) {
          if (msg.sender_id === auth.userId) state.myMessages.push(msg);
        }
        els.total.textContent = String(state.totalCount);
        els.mine.textContent = String(state.myMessages.length);

        if (!page.pageInfo.has_previous_page && !page.pageInfo.end_cursor) break;
        cursor = page.pageInfo.end_cursor;
        if (!cursor) break;
        if (!state.stopRequested) await sleep(FETCH_DELAY_MS);
      }
      log(state.stopRequested
        ? `Scan stopped. Total: ${state.totalCount}, Yours: ${state.myMessages.length}`
        : `Scan complete. Total: ${state.totalCount}, Yours: ${state.myMessages.length}`,
        state.stopRequested ? 'warn' : undefined);
    } catch (err) {
      handleFlowError(err as FlowError, 'scan');
    } finally {
      state.scanning = false;
      setBusy(false);
      els.btnUnsend.disabled = state.myMessages.length === 0;
    }
  }

  function onScanClick(): void { scanMessages(); }

  function onUnsendClick(): void {
    if (state.myMessages.length === 0) return;
    const previewItems = state.myMessages.slice(0, 8);
    els.previewList.innerHTML = previewItems.map((it) => `<div>• ${itemPreviewText(it)}</div>`).join('') +
      (state.myMessages.length > previewItems.length
        ? `<div>… and ${state.myMessages.length - previewItems.length} more</div>`
        : '');
    els.confirmText.textContent = `This will permanently delete ${state.myMessages.length} message(s) you sent in this conversation. This cannot be undone.`;
    els.confirmBox.style.display = 'block';
  }

  function onConfirmUnsend(): void {
    els.confirmBox.style.display = 'none';
    unsendAll();
  }

  async function unsendAll(): Promise<void> {
    const authResult = getAuth();
    if (!authResult.ok) { log(authResult.reason, 'error'); return; }
    const auth = authResult.auth;

    const threadInfo = getThreadInfo();
    if (!threadInfo) { log('Could not extract thread info from page. Try refreshing.', 'error'); return; }

    state.unsending = true;
    state.stopRequested = false;
    setBusy(true);
    const total = state.myMessages.length;
    let done = 0;
    let deleteDelay = BASE_DELETE_DELAY_MS;
    log(`Starting unsend of ${total} message(s)...`);

    for (const msg of state.myMessages.slice()) {
      if (state.stopRequested) { log('Stopped by user.', 'warn'); break; }

      let ok = false;
      let sessionExpired = false;
      for (let attempt = 1; attempt <= MAX_RETRIES && !ok && !state.stopRequested; attempt++) {
        let result: UnsendResult;
        try {
          result = await unsendMessageApi(threadInfo.threadIgid, msg.message_id, auth);
        } catch (err) {
          const flowErr = err as FlowError;
          if (flowErr.kind === 'session') {
            sessionExpired = true;
            break;
          }
          log(`Network error unsending a message (attempt ${attempt}/${MAX_RETRIES}).`, 'warn');
          await sleep(3000);
          continue;
        }

        if (result.status === 200 || result.status === 204) {
          ok = true;
        } else if (result.status === 429) {
          const retryAfterMs = (result.retryAfter || 3) * 1000;
          const backoff = retryAfterMs + 3000;
          deleteDelay = Math.min(deleteDelay + 1000, MAX_DELETE_DELAY_MS);
          log(`Rate limited (429). Waiting ${Math.round(backoff / 1000)}s, increasing delay to ${Math.round(deleteDelay / 1000)}s...`, 'warn');
          await sleep(backoff);
        } else if (result.status === 401 || result.status === 403) {
          sessionExpired = true;
          break;
        } else {
          log(`HTTP ${result.status} unsending message, skipping it.`, 'warn');
          ok = true; // treated as handled/skipped, move on
          break;
        }
      }

      if (sessionExpired) {
        log('Session expired or unauthorized. Please refresh Instagram and log in again.', 'error');
        setStatus(false, 'Session expired');
        state.unsending = false;
        setBusy(false);
        return;
      }

      if (ok) {
        done++;
        log(`Unsent (${done}/${total})`);
      } else if (!state.stopRequested) {
        log(`Giving up on a message after ${MAX_RETRIES} attempts.`, 'error');
        done++; // account for it so the loop still finishes deterministically
      }
      setProgress((done / total) * 100);
      if (!state.stopRequested) await sleep(jitteredDelay(deleteDelay, DELETE_JITTER_MS));
    }

    const stopped = state.stopRequested;
    state.myMessages = [];
    els.mine.textContent = '0';
    state.unsending = false;
    setBusy(false);
    log(stopped ? `Stopped. ${done}/${total} processed.` : `Done. ${done}/${total} messages processed.`);
  }

  function onStopClick(): void {
    state.stopRequested = true;
    log('Stop requested...', 'warn');
  }

  function handleFlowError(err: FlowError, phase: string): void {
    if (err.kind === 'session') {
      log('Session expired or unauthorized. Please refresh Instagram and log in again.', 'error');
      setStatus(false, 'Session expired');
    } else if (err.kind === 'network') {
      log(`Network error during ${phase}. Check your connection and try again.`, 'error');
    } else if (err.kind === 'http') {
      log(`Request failed during ${phase} (status ${err.status}).`, 'error');
      if (err.body) log(`Response: ${String(err.body).slice(0, 300)}`, 'error');
    } else {
      log(`Unexpected error during ${phase}: ${err}`, 'error');
    }
  }

  // -------------------------------------------------------------------
  // connection / thread detection
  // -------------------------------------------------------------------
  function refreshConnection(): void {
    state.currentUserId = getCookie('ds_user_id');
    state.csrfToken = getCookie('csrftoken');
    if (!state.appId) tryExtractAppIdFromPage();
    if (state.currentUserId && state.csrfToken) {
      const appIdNote = state.appId ? '' : ' — waiting for App ID (switch chats once)';
      setStatus(true, `Connected (user ${state.currentUserId})${appIdNote}`);
    } else {
      setStatus(false, 'Not connected — log in to Instagram');
    }
  }

  function refreshThreadDisplay(): void {
    const id = getUrlThreadId();
    if (els && els.thread) els.thread.textContent = id || '—';
  }

  function watchUrlChanges(): void {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        state.myMessages = [];
        state.totalCount = 0;
        if (els) {
          els.total.textContent = '0';
          els.mine.textContent = '0';
          els.btnUnsend.disabled = true;
        }
        setProgress(0);
        refreshThreadDisplay();
      }
    }, 1000);
  }

  function init(): void {
    if (!/(^|\.)instagram\.com$/.test(location.hostname)) return;
    installAppIdInterceptor();
    injectStyles();
    injectPanel();
    tryExtractAppIdFromPage();
    refreshConnection();
    refreshThreadDisplay();
    watchUrlChanges();
    setInterval(refreshConnection, 15000);
  }

  // Install the interceptor immediately so it can catch Instagram's own
  // early requests, even before the DOM/panel is ready.
  installAppIdInterceptor();

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
