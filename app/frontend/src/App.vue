<template>
  <div class="app-shell" :class="{ 'login-shell': !authChecking && authEnabled && !authenticated }">
    <div class="ambient ambient-one"></div>
    <div class="ambient ambient-two"></div>

    <main v-if="authChecking" class="auth-loading-panel" aria-live="polite">
      <div class="brand-mark" aria-hidden="true">
        <Cloud :size="30" :stroke-width="2.2" />
      </div>
      <LoaderCircle class="spin" :size="22" />
      <span>正在检查登录状态</span>
    </main>

    <main v-else-if="authEnabled && !authenticated" class="login-panel">
      <section class="login-brand-panel">
        <div class="login-brand-heading">
          <div class="brand-mark login-brand-mark" aria-hidden="true">
            <Cloud :size="31" :stroke-width="2.2" />
          </div>
          <div>
            <p class="eyebrow">ISTOREOS · 安全登录</p>
            <h1>Cloudflare 隧道管理</h1>
          </div>
        </div>

        <p class="login-intro">完成身份验证后，可以查看隧道状态、保存连接令牌并控制服务启停。</p>

        <div class="login-security-card">
          <ShieldCheck :size="22" />
          <div>
            <strong>本机安全验证</strong>
            <span>账号和密码仅由当前路由器验证，不会发送至 Cloudflare。</span>
          </div>
        </div>

        <ul class="login-points">
          <li><span></span>未登录时，所有管理接口都会被拦截</li>
          <li><span></span>连续输错 5 次，将暂停登录 5 分钟</li>
          <li><span></span>登录状态到期后需要重新验证</li>
        </ul>
      </section>

      <section class="login-form-panel">
        <div class="login-form-heading">
          <div class="section-icon"><LockKeyhole :size="20" /></div>
          <div>
            <h2>登录管理后台</h2>
            <p>请输入路由器管理员设置的账号和密码。</p>
          </div>
        </div>

        <form class="login-form" @submit.prevent="login">
          <label class="field-label" for="login-user">管理账号</label>
          <div class="login-field">
            <UserRound :size="18" />
            <input
              id="login-user"
              v-model="loginUser"
              type="text"
              maxlength="200"
              autocomplete="username"
              placeholder="请输入管理账号"
              :disabled="loginBusy"
              autofocus
            />
          </div>

          <label class="field-label login-password-label" for="login-password">登录密码</label>
          <div class="login-field">
            <LockKeyhole :size="18" />
            <input
              id="login-password"
              v-model="loginPassword"
              :type="showLoginPassword ? 'text' : 'password'"
              maxlength="500"
              autocomplete="current-password"
              placeholder="请输入登录密码"
              :disabled="loginBusy"
            />
            <button
              type="button"
              class="icon-button login-eye-button"
              :title="showLoginPassword ? '隐藏密码' : '显示密码'"
              :aria-label="showLoginPassword ? '隐藏密码' : '显示密码'"
              @click="showLoginPassword = !showLoginPassword"
            >
              <EyeOff v-if="showLoginPassword" :size="19" />
              <Eye v-else :size="19" />
            </button>
          </div>

          <div v-if="loginError" class="notice notice-error login-notice" role="alert">
            <CircleAlert :size="18" />
            <span>{{ loginError }}</span>
          </div>

          <button class="button button-primary login-button" type="submit" :disabled="loginBusy || !loginUser || !loginPassword">
            <LoaderCircle v-if="loginBusy" class="spin" :size="19" />
            <LogIn v-else :size="19" />
            {{ loginBusy ? '正在验证' : '进入管理后台' }}
          </button>
        </form>

        <p class="login-footer">中文定制版 2026.8.2-zh-cn.7 · 仅限授权人员访问</p>
      </section>
    </main>

    <main v-else class="console-panel">
      <header class="topbar">
        <div class="brand-block">
          <div class="brand-mark" aria-hidden="true">
            <Cloud :size="30" :stroke-width="2.2" />
          </div>
          <div>
            <p class="eyebrow">ISTOREOS · 内网管理工具</p>
            <h1>Cloudflare 隧道管理</h1>
            <p class="subtitle">在路由器上集中保存令牌，并控制 Cloudflare Tunnel 的启停。</p>
          </div>
        </div>

        <div class="topbar-actions">
          <div class="status-pill" :class="statusClass" aria-live="polite">
            <span class="status-dot"></span>
            {{ statusText }}
          </div>
          <button v-if="authEnabled" type="button" class="logout-button" :disabled="logoutBusy" @click="logout">
            <LoaderCircle v-if="logoutBusy" class="spin" :size="16" />
            <LogOut v-else :size="16" />
            退出
          </button>
        </div>
      </header>

      <section class="dashboard-grid">
        <section class="surface control-surface">
          <div class="section-title">
            <div class="section-icon"><KeyRound :size="19" /></div>
            <div>
              <h2>隧道连接令牌</h2>
              <p>从 Cloudflare Zero Trust 控制台复制令牌，也可以直接粘贴完整安装命令。</p>
            </div>
          </div>

          <label class="field-label" for="tunnel-token">连接令牌</label>
          <div class="token-field" :class="{ disabled: running }">
            <input
              id="tunnel-token"
              v-model="token"
              :type="showToken ? 'text' : 'password'"
              :disabled="running || busy"
              autocomplete="off"
              spellcheck="false"
              :placeholder="savedTokenPresent ? '令牌已安全保存；如需更换，请先停止隧道' : '粘贴 eyJ... 令牌或 cloudflared service install ... 命令'"
              @keydown.enter.prevent="saveToken"
            />
            <button
              v-if="normalizedToken"
              type="button"
              class="icon-button"
              :title="showToken ? '隐藏令牌' : '显示令牌'"
              :aria-label="showToken ? '隐藏令牌' : '显示令牌'"
              @click="showToken = !showToken"
            >
              <EyeOff v-if="showToken" :size="19" />
              <Eye v-else :size="19" />
            </button>
          </div>

          <div class="field-note">
            <ShieldCheck :size="16" />
            <span>令牌只保存在路由器本机，完整内容不会返回浏览器，也不会显示在日志里。</span>
          </div>

          <div class="action-row">
            <button
              type="button"
              class="button button-secondary"
              :disabled="busy || running || !normalizedToken"
              @click="saveToken"
            >
              <Save :size="17" />
              保存令牌
            </button>
            <button
              type="button"
              class="button"
              :class="running ? 'button-danger' : 'button-primary'"
              :disabled="busy || tokenChanged || !savedTokenPresent"
              @click="toggleTunnel"
            >
              <LoaderCircle v-if="busy" class="spin" :size="18" />
              <Square v-else-if="running" :size="16" fill="currentColor" />
              <Play v-else :size="18" fill="currentColor" />
              {{ busy ? '正在处理' : running ? '停止隧道' : '启动隧道' }}
            </button>
          </div>

          <div v-if="notice.text" class="notice" :class="`notice-${notice.type}`" role="status">
            <CircleCheck v-if="notice.type === 'success'" :size="18" />
            <CircleAlert v-else :size="18" />
            <span>{{ notice.text }}</span>
          </div>
        </section>

        <aside class="surface detail-surface">
          <div class="section-title compact">
            <div class="section-icon"><Gauge :size="19" /></div>
            <div>
              <h2>连接详情</h2>
              <p>显示当前服务实际使用的运行参数。</p>
            </div>
          </div>

          <dl class="detail-list">
            <div class="detail-row">
              <dt>服务状态</dt>
              <dd :class="running ? 'value-good' : 'value-muted'">{{ statusText }}</dd>
            </div>
            <div class="detail-row">
              <dt>隧道编号</dt>
              <dd class="mono" :title="details.tunnel_id || ''">{{ shortTunnelId }}</dd>
            </div>
            <div class="detail-row">
              <dt>连接协议</dt>
              <dd>{{ protocolLabel }}</dd>
            </div>
            <div class="detail-row">
              <dt>边缘网络 IP</dt>
              <dd>{{ edgeIpLabel }}</dd>
            </div>
            <div class="detail-row">
              <dt>管理端口</dt>
              <dd class="mono">{{ details.webui_port || '14333' }}</dd>
            </div>
            <div class="detail-row">
              <dt>核心版本</dt>
              <dd class="mono">{{ versionNumber }}</dd>
            </div>
          </dl>

          <button class="refresh-button" type="button" :disabled="refreshing" @click="refreshAll">
            <RefreshCw :class="{ spin: refreshing }" :size="16" />
            刷新状态
          </button>
        </aside>
      </section>

      <section v-if="authEnabled" class="account-panel surface">
        <div class="account-heading">
          <div class="section-title account-title">
            <div class="section-icon"><UserRound :size="19" /></div>
            <div>
              <h2>登录设置</h2>
              <p>修改管理后台的登录账号和密码，保存后立即生效。</p>
            </div>
          </div>
          <span v-if="authProfile.default_credentials" class="default-credential-badge">当前使用默认密码</span>
        </div>

        <div v-if="authProfile.default_credentials" class="default-credential-note">
          <ShieldCheck :size="18" />
          <span>首次登录后建议在这里更换账号和密码。新密码只保存加密结果。</span>
        </div>

        <form class="credential-form" @submit.prevent="changeCredentials">
          <div class="credential-fields">
            <label>
              <span class="field-label">当前密码</span>
              <input
                v-model="currentPassword"
                type="password"
                maxlength="128"
                autocomplete="current-password"
                placeholder="请输入当前密码"
                :disabled="credentialBusy"
              />
            </label>
            <label>
              <span class="field-label">新管理账号</span>
              <input
                v-model="newUsername"
                type="text"
                maxlength="64"
                autocomplete="username"
                placeholder="请输入新管理账号"
                :disabled="credentialBusy"
              />
            </label>
            <label>
              <span class="field-label">新密码</span>
              <input
                v-model="newPassword"
                type="password"
                maxlength="128"
                autocomplete="new-password"
                placeholder="至少 8 个字符"
                :disabled="credentialBusy"
              />
            </label>
            <label>
              <span class="field-label">确认新密码</span>
              <input
                v-model="confirmPassword"
                type="password"
                maxlength="128"
                autocomplete="new-password"
                placeholder="请再次输入新密码"
                :disabled="credentialBusy"
              />
            </label>
          </div>

          <div class="credential-actions">
            <div v-if="credentialNotice.text" class="notice credential-notice" :class="`notice-${credentialNotice.type}`" role="status">
              <CircleCheck v-if="credentialNotice.type === 'success'" :size="18" />
              <CircleAlert v-else :size="18" />
              <span>{{ credentialNotice.text }}</span>
            </div>
            <button
              type="submit"
              class="button button-primary credential-button"
              :disabled="credentialBusy || !currentPassword || !newUsername || !newPassword || !confirmPassword"
            >
              <LoaderCircle v-if="credentialBusy" class="spin" :size="18" />
              <Save v-else :size="17" />
              {{ credentialBusy ? '正在保存' : '保存登录信息' }}
            </button>
          </div>
        </form>
      </section>

      <section class="guide-panel">
        <div class="guide-heading">
          <BookOpen :size="20" />
          <div>
            <h2>使用指南</h2>
            <p>按照以下步骤完成配置；令牌变更后需要先保存，再启动隧道。</p>
          </div>
        </div>
        <ol class="steps">
          <li><span>1</span><p><strong>创建隧道</strong>在 Zero Trust 控制台新建一个远程管理隧道。</p></li>
          <li><span>2</span><p><strong>粘贴令牌</strong>复制连接器令牌或完整安装命令，然后点“保存令牌”。</p></li>
          <li><span>3</span><p><strong>启动服务</strong>选择“启动隧道”，状态显示“正在运行”即表示启动成功。</p></li>
        </ol>
      </section>

      <footer class="footer-bar">
        <div>
          <span class="build-tag">中文定制版 2026.8.2-zh-cn.7</span>
          <span v-if="updateInfo.update" class="update-tip">官方有新版本 {{ updateInfo.latest_version }}</span>
        </div>
        <nav aria-label="相关链接">
          <a href="https://dash.cloudflare.com/one/" target="_blank" rel="noreferrer">
            Zero Trust 控制台 <ExternalLink :size="14" />
          </a>
          <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/" target="_blank" rel="noreferrer">
            新建隧道 <ExternalLink :size="14" />
          </a>
          <a href="https://github.com/w87051809/cloudflared-web-zh-cn" target="_blank" rel="noreferrer">
            项目主页 <ExternalLink :size="14" />
          </a>
        </nav>
      </footer>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeMount, reactive, ref } from 'vue'
import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Square,
  UserRound,
} from '@lucide/vue'

type NoticeType = 'success' | 'error'

const endpoint = ''
const authChecking = ref(true)
const authEnabled = ref(false)
const authenticated = ref(false)
const loginUser = ref('')
const loginPassword = ref('')
const loginBusy = ref(false)
const logoutBusy = ref(false)
const loginError = ref('')
const showLoginPassword = ref(false)
const token = ref('')
const savedTokenPresent = ref(false)
const version = ref('')
const showToken = ref(false)
const loading = ref(true)
const busy = ref(false)
const refreshing = ref(false)
const notice = reactive<{ type: NoticeType; text: string }>({ type: 'success', text: '' })
const authProfile = reactive({ username: '', default_credentials: false })
const currentPassword = ref('')
const newUsername = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const credentialBusy = ref(false)
const credentialNotice = reactive<{ type: NoticeType; text: string }>({ type: 'success', text: '' })
const config = reactive({ start: false })
const details = reactive({
  running: false,
  desired_start: false,
  tunnel_id: '',
  protocol: 'auto',
  edge_ip_version: 'auto',
  webui_port: '14333',
})
const updateInfo = reactive({ latest_version: '', update: false })

const normalizedToken = computed(() => {
  const value = token.value.trim()
  if (!value) return ''
  const parts = value.split(/\s+/)
  return parts.length > 1 ? parts[parts.length - 1] : value
})
const tokenChanged = computed(() => Boolean(normalizedToken.value))
const running = computed(() => details.running)
const statusText = computed(() => {
  if (loading.value) return '正在读取'
  if (details.running) return '正在运行'
  if (details.desired_start) return '正在启动'
  return '已停止'
})
const statusClass = computed(() => {
  if (loading.value || details.desired_start && !details.running) return 'status-waiting'
  return details.running ? 'status-running' : 'status-stopped'
})
const shortTunnelId = computed(() => {
  if (!details.tunnel_id) return '尚未识别'
  return `${details.tunnel_id.slice(0, 8)}…${details.tunnel_id.slice(-4)}`
})
const versionNumber = computed(() => version.value.match(/version\s+([^\s]+)/i)?.[1] || version.value || '读取中')
const protocolLabel = computed(() => ({ auto: '自动选择', http2: 'HTTP/2', quic: 'QUIC' }[details.protocol] || details.protocol))
const edgeIpLabel = computed(() => ({ auto: '自动选择', '4': '仅 IPv4', '6': '仅 IPv6' }[details.edge_ip_version] || details.edge_ip_version))

onBeforeMount(bootstrap)

function showNotice(type: NoticeType, text: string) {
  notice.type = type
  notice.text = text
}

async function requestJson(path: string, options?: RequestInit) {
  const response = await fetch(endpoint + path, options)
  if (!response.ok) {
    const raw = (await response.text()).trim()
    let message = raw
    try {
      message = JSON.parse(raw).message || raw
    } catch (_error) {}
    if (response.status === 401 && path !== '/auth/login') {
      authenticated.value = false
      loginUser.value = ''
      loginPassword.value = ''
      loginError.value = '登录状态已经失效，请重新登录。'
    }
    throw new Error(message || `请求失败（${response.status}）`)
  }
  return response.json()
}

async function requestText(path: string) {
  const response = await fetch(endpoint + path)
  if (!response.ok) {
    if (response.status === 401) {
      authenticated.value = false
      loginPassword.value = ''
      loginError.value = '登录状态已经失效，请重新登录。'
    }
    throw new Error(response.status === 401 ? '请重新登录。' : '读取核心版本失败')
  }
  return response.text()
}

async function bootstrap() {
  try {
    const response = await fetch(endpoint + '/auth/status')
    if (!response.ok) throw new Error('无法读取登录状态。')
    const status = await response.json()
    authEnabled.value = Boolean(status.enabled)
    authenticated.value = Boolean(status.authenticated)
    if (authenticated.value) await refreshAll()
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '无法连接管理服务。'
  } finally {
    authChecking.value = false
  }
}

async function login() {
  loginBusy.value = true
  loginError.value = ''
  try {
    await requestJson('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUser.value, password: loginPassword.value }),
    })
    authenticated.value = true
    loginUser.value = ''
    loginPassword.value = ''
    showLoginPassword.value = false
    loading.value = true
    notice.text = ''
    await refreshAll()
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败，请重新尝试。'
  } finally {
    loginBusy.value = false
  }
}

async function logout() {
  logoutBusy.value = true
  try {
    await requestJson('/auth/logout', { method: 'POST' })
    authenticated.value = false
    loginUser.value = ''
    loginPassword.value = ''
    loginError.value = ''
    notice.text = ''
  } catch (error) {
    showNotice('error', error instanceof Error ? error.message : '退出登录失败。')
  } finally {
    logoutBusy.value = false
  }
}

async function loadDetails() {
  const data = await requestJson('/details')
  Object.assign(details, data)
  config.start = Boolean(data.desired_start)
}

async function refreshAll() {
  refreshing.value = true
  try {
    const [configData, versionText, updateData, profileData] = await Promise.all([
      requestJson('/config'),
      requestText('/version'),
      requestJson('/new-version').catch(() => ({ latest_version: '', update: false })),
      requestJson('/auth/profile'),
    ])
    token.value = ''
    savedTokenPresent.value = Boolean(configData.token_set)
    version.value = versionText.trim()
    updateInfo.latest_version = updateData.latest_version || ''
    updateInfo.update = Boolean(updateData.update)
    authProfile.username = profileData.username || ''
    authProfile.default_credentials = Boolean(profileData.default_credentials)
    if (!newUsername.value) newUsername.value = authProfile.username
    await loadDetails()
  } catch (error) {
    showNotice('error', error instanceof Error ? error.message : '读取服务状态失败')
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function changeCredentials() {
  credentialNotice.text = ''
  if (newUsername.value.trim().length < 3) {
    credentialNotice.type = 'error'
    credentialNotice.text = '新管理账号至少需要 3 个字符。'
    return
  }
  if (newPassword.value.length < 8) {
    credentialNotice.type = 'error'
    credentialNotice.text = '新密码至少需要 8 个字符。'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    credentialNotice.type = 'error'
    credentialNotice.text = '两次输入的新密码不一致。'
    return
  }

  credentialBusy.value = true
  try {
    const profile = await requestJson('/auth/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: currentPassword.value,
        username: newUsername.value.trim(),
        password: newPassword.value,
      }),
    })
    authProfile.username = profile.username
    authProfile.default_credentials = Boolean(profile.default_credentials)
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    credentialNotice.type = 'success'
    credentialNotice.text = '登录账号和密码已经更新，下次登录请使用新信息。'
  } catch (error) {
    credentialNotice.type = 'error'
    credentialNotice.text = error instanceof Error ? error.message : '保存登录信息失败。'
  } finally {
    credentialBusy.value = false
  }
}

async function saveToken() {
  if (!normalizedToken.value) {
    showNotice('error', '请先填写隧道连接令牌。')
    return
  }
  busy.value = true
  try {
    await requestJson('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: normalizedToken.value }),
    })
    token.value = ''
    showToken.value = false
    savedTokenPresent.value = true
    showNotice('success', '令牌已经保存到路由器。')
    await loadDetails()
  } catch (error) {
    showNotice('error', error instanceof Error ? error.message : '保存令牌失败')
  } finally {
    busy.value = false
  }
}

async function toggleTunnel() {
  busy.value = true
  const shouldStart = !running.value
  try {
    await requestJson('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: shouldStart }),
    })
    showNotice('success', shouldStart ? '启动命令已发送，正在建立连接。' : '隧道已经停止。')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 500 : 900))
      await loadDetails()
      if (details.running === shouldStart) break
    }
  } catch (error) {
    showNotice('error', error instanceof Error ? error.message : '操作失败')
    await loadDetails().catch(() => undefined)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(html) { min-width: 320px; background: #07111f; }
:global(body) {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  color: #132033;
  background: #07111f;
  font-family: "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
}
:global(button), :global(input) { font: inherit; }

.app-shell {
  position: relative;
  min-height: 100vh;
  overflow: hidden;
  padding: 48px 24px;
  background:
    linear-gradient(135deg, rgba(8, 24, 42, 0.98), rgba(5, 13, 25, 0.98)),
    repeating-linear-gradient(90deg, transparent 0 79px, rgba(255,255,255,0.025) 80px);
}
.app-shell::before {
  content: "";
  position: absolute;
  inset: 0;
  opacity: .2;
  pointer-events: none;
  background-image: radial-gradient(rgba(255,255,255,.22) .7px, transparent .7px);
  background-size: 18px 18px;
}
.app-shell.login-shell { display: flex; align-items: center; justify-content: center; }
.ambient { position: absolute; border-radius: 999px; filter: blur(12px); opacity: .32; pointer-events: none; }
.ambient-one { width: 420px; height: 420px; top: -190px; right: 7%; background: #f6821f; }
.ambient-two { width: 300px; height: 300px; bottom: -180px; left: 5%; background: #2f80ed; }

.console-panel {
  position: relative;
  z-index: 1;
  width: min(1100px, 100%);
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.72);
  border-radius: 24px;
  background: rgba(245, 248, 252, .97);
  box-shadow: 0 32px 100px rgba(0, 0, 0, .42);
  animation: panel-in .5s ease-out both;
}
.auth-loading-panel {
  position: relative;
  z-index: 1;
  display: flex;
  width: min(420px, 100%);
  min-height: 160px;
  margin: calc(50vh - 128px) auto 0;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #dce8f5;
  border: 1px solid rgba(255,255,255,.18);
  border-radius: 22px;
  background: rgba(12, 29, 51, .92);
  box-shadow: 0 28px 80px rgba(0,0,0,.38);
  font-size: 14px;
  font-weight: 800;
}
.login-panel {
  position: relative;
  z-index: 1;
  display: grid;
  width: min(960px, 100%);
  min-height: min(600px, calc(100vh - 96px));
  margin: 0;
  overflow: hidden;
  grid-template-columns: minmax(0, 1.05fr) minmax(390px, .95fr);
  border: 1px solid rgba(255,255,255,.72);
  border-radius: 26px;
  background: #f7f9fc;
  box-shadow: 0 32px 100px rgba(0,0,0,.44);
  animation: panel-in .5s ease-out both;
}
.login-brand-panel {
  position: relative;
  padding: 52px 46px;
  color: #fff;
  background:
    radial-gradient(circle at 90% 8%, rgba(246,130,31,.3), transparent 32%),
    linear-gradient(145deg, #0b1d33, #102c4b 66%, #173d64);
}
.login-brand-panel::after {
  content: "";
  position: absolute;
  right: -90px;
  bottom: -120px;
  width: 300px;
  height: 300px;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 50%;
  box-shadow: 0 0 0 42px rgba(255,255,255,.025), 0 0 0 84px rgba(255,255,255,.018);
}
.login-brand-heading { position: relative; z-index: 1; display: flex; align-items: center; gap: 18px; }
.login-brand-mark { width: 62px; height: 62px; border-radius: 19px; }
.login-brand-heading h1 { font-size: clamp(26px, 3vw, 35px); }
.login-intro { position: relative; z-index: 1; max-width: 430px; margin: 34px 0 0; color: #c3d2e2; font-size: 15px; line-height: 1.8; }
.login-security-card {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  gap: 13px;
  margin-top: 38px;
  padding: 17px 18px;
  color: #dce9f6;
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 15px;
  background: rgba(255,255,255,.07);
}
.login-security-card > svg { flex: 0 0 auto; margin-top: 1px; color: #54d99a; }
.login-security-card strong { display: block; margin-bottom: 5px; color: #fff; font-size: 14px; }
.login-security-card span { display: block; color: #acc1d7; font-size: 12px; line-height: 1.65; }
.login-points { position: relative; z-index: 1; display: grid; gap: 13px; margin: 28px 0 0; padding: 0; color: #b8cadc; list-style: none; font-size: 12px; }
.login-points li { display: flex; align-items: center; gap: 10px; }
.login-points li > span { width: 7px; height: 7px; border-radius: 50%; background: #f6821f; box-shadow: 0 0 0 4px rgba(246,130,31,.12); }
.login-form-panel { display: flex; padding: 52px 46px 32px; flex-direction: column; justify-content: center; background: linear-gradient(180deg, #fff, #f6f8fb); }
.login-form-heading { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 30px; }
.login-form-heading h2 { margin: 1px 0 0; color: #142337; font-size: 21px; letter-spacing: -.02em; }
.login-form-heading p { margin: 6px 0 0; color: #718096; font-size: 12px; line-height: 1.6; }
.login-form { width: 100%; }
.login-field { display: flex; align-items: center; border: 1px solid #ccd7e3; border-radius: 12px; background: #fff; transition: .2s ease; }
.login-field:focus-within { border-color: #f6821f; box-shadow: 0 0 0 4px rgba(246,130,31,.12); }
.login-field > svg { flex: 0 0 auto; margin-left: 14px; color: #718096; }
.login-field input { width: 100%; min-width: 0; padding: 13px 12px; color: #1d2b3d; border: 0; outline: 0; background: transparent; font-size: 13px; }
.login-password-label { margin-top: 20px; }
.login-eye-button { flex: 0 0 auto; }
.login-notice { margin-top: 17px; }
.login-button { width: 100%; min-height: 48px; margin-top: 24px; font-size: 14px; }
.login-footer { margin: 32px 0 0; color: #8a98a9; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; text-align: center; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 30px 34px;
  color: #fff;
  background: linear-gradient(120deg, #0c1d33, #102946 70%, #17395e);
}
.topbar-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; }
.logout-button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  color: #d9e6f4;
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 999px;
  background: rgba(255,255,255,.07);
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}
.logout-button:hover:not(:disabled) { color: #fff; background: rgba(255,255,255,.13); }
.logout-button:disabled { cursor: wait; opacity: .6; }
.brand-block { display: flex; align-items: center; gap: 18px; }
.brand-mark {
  display: grid;
  flex: 0 0 auto;
  width: 58px;
  height: 58px;
  place-items: center;
  color: #fff;
  border: 1px solid rgba(255,255,255,.3);
  border-radius: 18px;
  background: linear-gradient(145deg, #ff9b35, #f46f12);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 12px 32px rgba(246,130,31,.26);
}
.eyebrow { margin: 0 0 5px; color: #85a4c7; font-size: 11px; font-weight: 800; letter-spacing: .18em; }
h1 { margin: 0; font-size: clamp(24px, 4vw, 34px); line-height: 1.15; letter-spacing: -.04em; }
.subtitle { margin: 8px 0 0; color: #b8c8da; font-size: 14px; }
.status-pill {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 9px;
  min-width: 110px;
  padding: 10px 14px;
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 999px;
  font-size: 13px;
  font-weight: 800;
  background: rgba(255,255,255,.08);
}
.status-dot { width: 9px; height: 9px; border-radius: 50%; background: #91a0b4; }
.status-running .status-dot { background: #45db91; box-shadow: 0 0 0 5px rgba(69,219,145,.12); animation: pulse 1.8s infinite; }
.status-stopped .status-dot { background: #ff7979; }
.status-waiting .status-dot { background: #f6b64a; animation: pulse 1.1s infinite; }

.dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(290px, .8fr); gap: 20px; padding: 26px 26px 20px; }
.surface { border: 1px solid #dce4ee; border-radius: 18px; background: #fff; box-shadow: 0 8px 24px rgba(17,36,60,.06); }
.control-surface { padding: 26px; }
.detail-surface { padding: 26px; background: linear-gradient(180deg, #f9fbfd, #f3f7fb); }
.section-title { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
.section-title.compact { margin-bottom: 14px; }
.section-icon { display: grid; flex: 0 0 auto; width: 38px; height: 38px; place-items: center; color: #f27217; border-radius: 11px; background: #fff0e4; }
.section-title h2, .guide-heading h2 { margin: 0; color: #132033; font-size: 18px; letter-spacing: -.02em; }
.section-title p, .guide-heading p { margin: 5px 0 0; color: #718096; font-size: 13px; line-height: 1.65; }
.field-label { display: block; margin-bottom: 8px; color: #334155; font-size: 13px; font-weight: 800; }
.token-field { display: flex; align-items: center; border: 1px solid #cbd6e2; border-radius: 12px; background: #f8fafc; transition: .2s ease; }
.token-field:focus-within { border-color: #f6821f; background: #fff; box-shadow: 0 0 0 4px rgba(246,130,31,.12); }
.token-field.disabled { opacity: .7; }
.token-field input { width: 100%; min-width: 0; padding: 13px 15px; color: #1d2b3d; border: 0; outline: 0; background: transparent; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
.icon-button { display: grid; width: 44px; height: 44px; margin-right: 2px; place-items: center; color: #65758a; border: 0; border-radius: 10px; background: transparent; cursor: pointer; }
.icon-button:hover { color: #f27217; background: #fff0e4; }
.field-note { display: flex; align-items: center; gap: 7px; margin-top: 10px; color: #64748b; font-size: 12px; }
.field-note svg { color: #2f9e68; }
.action-row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
.button { display: inline-flex; min-height: 42px; align-items: center; justify-content: center; gap: 8px; padding: 0 18px; border-radius: 11px; font-size: 13px; font-weight: 800; cursor: pointer; transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease; }
.button:hover:not(:disabled) { transform: translateY(-1px); }
.button:disabled { cursor: not-allowed; opacity: .45; }
.button-secondary { color: #26364b; border: 1px solid #ccd7e3; background: #fff; }
.button-secondary:hover:not(:disabled) { border-color: #9fb0c2; box-shadow: 0 7px 18px rgba(20,38,61,.09); }
.button-primary { color: #fff; border: 1px solid #e96d13; background: linear-gradient(135deg, #ff982f, #ef7116); box-shadow: 0 10px 22px rgba(239,113,22,.25); }
.button-danger { color: #fff; border: 1px solid #c74747; background: linear-gradient(135deg, #e46262, #bf3f3f); box-shadow: 0 10px 22px rgba(191,63,63,.2); }
.notice { display: flex; align-items: flex-start; gap: 9px; margin-top: 18px; padding: 11px 13px; border-radius: 10px; font-size: 13px; line-height: 1.5; }
.notice-success { color: #17603d; background: #eaf8f1; border: 1px solid #bfe8d2; }
.notice-error { color: #912f2f; background: #fff0f0; border: 1px solid #f1c4c4; }
.detail-list { margin: 0; }
.detail-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid #e1e8f0; }
.detail-row:last-child { border-bottom: 0; }
.detail-row dt { color: #718096; font-size: 12px; }
.detail-row dd { max-width: 62%; margin: 0; overflow: hidden; color: #26364b; font-size: 13px; font-weight: 800; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.detail-row .value-good { color: #168254; }
.detail-row .value-muted { color: #9b4a4a; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.refresh-button { display: inline-flex; align-items: center; gap: 7px; margin-top: 18px; padding: 8px 0; color: #42617f; border: 0; background: transparent; font-size: 12px; font-weight: 800; cursor: pointer; }
.refresh-button:hover { color: #f27217; }

.account-panel { margin: 0 26px 20px; padding: 24px 26px; }
.account-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.account-title { margin-bottom: 0; }
.default-credential-badge { flex: 0 0 auto; padding: 7px 10px; color: #9a5314; border: 1px solid #f0c28f; border-radius: 999px; background: #fff5e9; font-size: 11px; font-weight: 800; }
.default-credential-note { display: flex; align-items: center; gap: 9px; margin-top: 18px; padding: 11px 13px; color: #7b4b1f; border: 1px solid #f0d1ad; border-radius: 10px; background: #fff8ef; font-size: 12px; }
.default-credential-note svg { flex: 0 0 auto; color: #df761c; }
.credential-form { margin-top: 20px; }
.credential-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 18px; }
.credential-fields label { min-width: 0; }
.credential-fields input { width: 100%; min-height: 44px; padding: 0 13px; color: #1d2b3d; border: 1px solid #cbd6e2; border-radius: 11px; outline: 0; background: #f8fafc; font-size: 13px; transition: .2s ease; }
.credential-fields input:focus { border-color: #f6821f; background: #fff; box-shadow: 0 0 0 4px rgba(246,130,31,.12); }
.credential-fields input:disabled { cursor: wait; opacity: .6; }
.credential-actions { display: flex; align-items: center; justify-content: flex-end; gap: 14px; margin-top: 20px; }
.credential-notice { flex: 1 1 auto; margin-top: 0; }
.credential-button { flex: 0 0 auto; }

.guide-panel { margin: 0 26px 24px; padding: 22px 26px; border: 1px solid #d9e4ef; border-radius: 18px; background: linear-gradient(120deg, #eef6ff, #f8fbff); }
.guide-heading { display: flex; align-items: flex-start; gap: 11px; }
.guide-heading > svg { margin-top: 2px; color: #2f73b8; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 20px 0 0; padding: 0; list-style: none; }
.steps li { display: flex; align-items: flex-start; gap: 11px; }
.steps li > span { display: grid; flex: 0 0 auto; width: 28px; height: 28px; place-items: center; color: #fff; border-radius: 9px; background: #163a60; font-size: 12px; font-weight: 900; }
.steps p { margin: 0; color: #65758a; font-size: 12px; line-height: 1.65; }
.steps strong { display: block; margin-bottom: 2px; color: #24364b; font-size: 13px; }

.footer-bar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 17px 26px; color: #7a899b; border-top: 1px solid #dce4ee; background: #f3f6f9; font-size: 11px; }
.build-tag { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.update-tip { margin-left: 10px; color: #a75d18; }
.footer-bar nav { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 16px; }
.footer-bar a { display: inline-flex; align-items: center; gap: 4px; color: #52677f; font-weight: 800; text-decoration: none; }
.footer-bar a:hover { color: #f27217; }
.spin { animation: spin .8s linear infinite; }

@keyframes panel-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { opacity: .45; transform: scale(.82); } }

@media (max-width: 820px) {
  .app-shell { padding: 20px 12px; }
  .login-panel { min-height: min(600px, calc(100vh - 40px)); grid-template-columns: 1fr; }
  .login-brand-panel { padding: 34px 30px; }
  .login-intro { margin-top: 24px; }
  .login-security-card { margin-top: 24px; }
  .login-points { display: none; }
  .login-form-panel { padding: 38px 30px 30px; }
  .topbar { align-items: flex-start; padding: 24px 20px; }
  .brand-mark { width: 48px; height: 48px; border-radius: 14px; }
  .subtitle { display: none; }
  .status-pill { min-width: auto; padding: 9px 11px; }
  .dashboard-grid { grid-template-columns: 1fr; padding: 16px; }
  .account-panel { margin: 0 16px 18px; padding: 20px; }
  .credential-fields { grid-template-columns: 1fr; }
  .credential-actions { align-items: stretch; flex-direction: column; }
  .credential-button { width: 100%; }
  .guide-panel { margin: 0 16px 18px; padding: 20px; }
  .steps { grid-template-columns: 1fr; }
  .footer-bar { align-items: flex-start; flex-direction: column; padding: 17px 20px; }
  .footer-bar nav { justify-content: flex-start; }
}
@media (max-width: 520px) {
  .app-shell { padding: 0; }
  .auth-loading-panel { width: 100%; min-height: 100vh; margin: 0; border: 0; border-radius: 0; }
  .login-panel { min-height: 100vh; border: 0; border-radius: 0; }
  .login-brand-panel { padding: 28px 22px; }
  .login-brand-mark { width: 50px; height: 50px; border-radius: 15px; }
  .login-intro { font-size: 13px; }
  .login-security-card { padding: 14px; }
  .login-form-panel { padding: 32px 22px 24px; justify-content: flex-start; }
  .console-panel { min-height: 100vh; border: 0; border-radius: 0; }
  .topbar { flex-direction: column; gap: 16px; }
  .topbar-actions { width: 100%; justify-content: space-between; }
  .brand-block { align-items: flex-start; gap: 12px; }
  .eyebrow { font-size: 9px; }
  h1 { font-size: 25px; }
  .control-surface, .detail-surface { padding: 20px; }
  .action-row { flex-direction: column; }
  .button { width: 100%; }
  .footer-bar nav { gap: 11px; }
}
</style>
