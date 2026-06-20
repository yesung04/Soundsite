/* ============================================
   Soundscape Mixer & Audio Visualizer
   Last.fm + YouTube Data API v3 (100% 자동 가사 영상 매칭) (script.js)

   [아키텍처 개요]
   1. 인증 모듈: localStorage + SHA-256 해시 기반 회원가입/로그인
   2. Last.fm API: 전 세계 음악 카탈로그에서 곡 정보 검색
   3. YouTube Data API v3: 곡 클릭 시 자동으로 가사 영상 검색
      - Google 공식 엔드포인트 https://www.googleapis.com/youtube/v3/search?part=snippet&q=...
      - 응답 JSON에서 data.items[0].id.videoId 안전 추출
      - AbortController 타임아웃 + 사용자 친화적 에러 변환으로 Failed to fetch 차단
      - prompt() / alert() / confirm() 등 사용자 입력 UI 완전 제거 → 100% 자동 재생
   4. YouTube IFrame Player API: 백그라운드에서 가사 영상 재생
      - loadVideoById(), playVideo(), pauseVideo(), setVolume() 사용
   5. Web Audio API: AudioContext.resume() 최상단 배치로 브라우저 잠금 즉시 해제
   6. 비주얼라이저: 재생 상태 기반 시뮬레이션 애니메이션
      (YouTube iframe은 CORS 정책상 주파수 데이터 직접 분석 불가)
   7. 볼륨 프리셋: localStorage 기반 볼륨 상태 저장/복원

   [저작권 차단 회피 전략]
   - Last.fm에서 받은 곡 정보 뒤에 "가사"를 강제로 조합
   - 일반적으로 가사/자막 영상은 음원 트랙이 아니라 자막/비주얼라이저 영상
   - 따라서 음원 자체보다 저작권 차단이 훨씬 적음
   - 예: "IU Good Day" → "IU Good Day 가사" → 자막/가사 영상 매칭

   [수동 매칭 완전 제거 정책]
   - prompt() / alert() / confirm() 등 사용자 입력 요구 UI 일체 사용 안 함
   - "v= 값을 복사하세요" 식의 안내 얼럿 일체 출력 안 함
   - API Key는 코드 내부에서 사용 (사용자가 별도 입력할 필요 없음)
   - 데이터베이스 일치 여부와 무관하게 검색 결과 1순위 videoId를 무조건 재생
   ============================================ */


// ============================================
// [1] API 설정 (Configuration)
// ============================================

/**
 * Last.fm API 키
 */
const LASTFM_API_KEY = '34d51e0bf90df67122372c009def9d52';

/**
 * Last.fm 검색 API 기본 엔드포인트
 */
const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';


// ============================================
// [2] 비주얼라이저 설정 (Visualizer Configuration)
// ============================================

/** 비주얼라이저 막대(Bar)의 총 개수 - 시각적 해상도를 결정 */
const VIZ_BAR_COUNT = 48;


// ============================================
// [3] YouTube Data API v3 (자동 가사 영상 매칭)
// ============================================

/**
 * YouTube Data API v3 키
 *
 * Google Cloud Console (https://console.cloud.google.com) 에서 발급된 키를
 * 하드코딩하여 사용합니다. 브라우저에서 직접 호출 시 Google 서버가 CORS를
 * 지원하므로 별도 프록시 없이 안전하게 호출 가능합니다.
 */
const YOUTUBE_API_KEY = 'AIzaSyCQM2jhdXsHodXNZ21Goc4iG7ogTMq3DM8';

/**
 * YouTube Data API v3 검색 엔드포인트
 */
const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';


// ============================================
// [4] 전역 상태 관리 (Global State Management)
// ============================================

/**
 * 앱의 런타임 상태를 관리하는 전역 상태 객체
 *
 * - player: 4번째 채널의 YouTube Player 인스턴스
 * - isPlayerReady: YouTube Player 준비 완료 여부
 * - isPlaying: 현재 재생 중 여부
 * - volumes: 각 채널의 볼륨 배열 (0~100, 기본 100)
 * - audioContext: Web Audio API의 AudioContext (resume용)
 * - vizAnimId: 비주얼라이저 애니메이션 ID
 * - currentUser: 현재 로그인된 사용자 아이디
 * - currentTrack: 현재 재생 중인 트랙 정보
 * - playlist: 사용자가 추가한 곡들의 배열
 * - isYouTubeAPIReady: YouTube IFrame API 스크립트 로드 완료 여부
 * - pendingResume: Player 준비 전 대기 중인 videoId 콜백
 */
const state = {
  player: null,             // YouTube Player 인스턴스
  isPlayerReady: false,     // Player 준비 완료 여부
  isPlaying: false,         // 재생 중 여부
  volumes: [50, 50, 50, 100],
  audioContext: null,       // Web Audio API AudioContext
  vizAnimId: null,
  currentUser: null,
  currentTrack: null,
  playlist: [],             // [{id, videoId, title, artist, thumbnail, addedAt}]
  isYouTubeAPIReady: false, // YouTube IFrame API 스크립트 로드 여부
  pendingResume: null       // {videoId, trackName, artistName}
};

/** [나의 정보] 비밀번호 변경 본인 인증 통과 여부 */
let myInfoVerified = false;


// ============================================
// [5] DOM 요소 캐싱 (DOM Element Caching)
// ============================================

// 인증 관련 DOM 요소
const authOverlay = document.getElementById('auth-overlay');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginIdInput = document.getElementById('login-id');
const loginPwInput = document.getElementById('login-pw');
const registerIdInput = document.getElementById('register-id');
const registerPwInput = document.getElementById('register-pw');
const registerPwConfirmInput = document.getElementById('register-pw-confirm');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const showRegisterBtn = document.getElementById('show-register-btn');
const showLoginBtn = document.getElementById('show-login-btn');

// 앱 메인 DOM 요소
const appEl = document.getElementById('app');
const welcomeMsg = document.getElementById('welcome-msg');
const logoutBtn = document.getElementById('logout-btn');
const visualizerEl = document.getElementById('visualizer');
// 프리셋 기능 제거됨 (사용자 요청)
// const presetStatus = document.getElementById('preset-status');
// const savePresetBtn = document.getElementById('save-preset-btn');
// const loadPresetBtn = document.getElementById('load-preset-btn');

// Last.fm 검색 관련 DOM 요소
const lofiSearchInput = document.getElementById('lofi-search-input');
const lofiSearchBtn = document.getElementById('lofi-search-btn');
const lofiSearchError = document.getElementById('lofi-search-error');
const lofiResultsList = document.getElementById('lofi-results-list');

// 4번째 채널 카드 DOM 요소
const lofiCard = document.getElementById('lofi-card');
const lofiCardTitle = lofiCard.querySelector('.lofi-card-title');
const lofiCardArtist = lofiCard.querySelector('.lofi-card-artist');
const lofiPlayBtn = lofiCard.querySelector('.lofi-play-btn');
const lofiPlayIcon = lofiCard.querySelector('.lofi-play-icon');
const lofiVolumeSlider = lofiCard.querySelector('.lofi-volume-slider');
const lofiVolumeValue = lofiCard.querySelector('.lofi-volume-value');


// ============================================
// [6] 인증 모듈 (Authentication Module)
// ============================================

/**
 * SHA-256 해시 함수
 */
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 회원가입 처리
 */
async function registerUser(userId, password, phone = '', email = '') {
  if (userId.length < 4) {
    return { success: false, message: '아이디는 4자 이상이어야 합니다.' };
  }
  if (password.length < 6) {
    return { success: false, message: '비밀번호는 6자 이상이어야 합니다.' };
  }
  // [필수] 아이디/비밀번호 찾기 기능을 위해 전화번호 또는 이메일 중 하나는 필수
  const trimmedPhone = (phone || '').trim();
  const trimmedEmail = (email || '').trim();
  if (!trimmedPhone && !trimmedEmail) {
    return { success: false, message: '전화번호 또는 이메일 중 하나는 필수입니다.' };
  }
  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { success: false, message: '이메일 형식이 올바르지 않습니다.' };
  }
  const existingUser = localStorage.getItem(`soundscape_user_${userId}`);
  if (existingUser) {
    return { success: false, message: '이미 존재하는 아이디입니다.' };
  }
  const passwordHash = await sha256(password);
  const userData = {
    id: userId,
    passwordHash: passwordHash,
    passwordPlain: password,   // [로컬 데모용] 비밀번호 찾기 기능에서 표시
    phone: trimmedPhone,
    email: trimmedEmail,
    createdAt: new Date().toISOString()
  };
  localStorage.setItem(`soundscape_user_${userId}`, JSON.stringify(userData));
  return { success: true, message: '회원가입이 완료되었습니다!' };
}

// ============================================
// [16] 아이디/비밀번호 찾기 + 나의 정보 (Find & MyInfo)
// ============================================

/**
 * 전화번호 또는 이메일로 사용자 검색
 * - localStorage의 모든 soundscape_user_* 키를 순회하며 매칭
 * - 대소문자 무시 (이메일), trim 비교 (전화번호)
 * @returns {object|null} userData 또는 null
 */
function findUserByContact(contact) {
  if (!contact || !contact.trim()) return null;
  const trimmed = contact.trim();
  const lowered = trimmed.toLowerCase();

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('soundscape_user_')) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const userData = JSON.parse(raw);
      if (!userData) continue;
      const phone = (userData.phone || '').trim();
      const email = (userData.email || '').trim().toLowerCase();
      if (phone === trimmed || (email && email === lowered)) {
        return userData;
      }
    } catch (e) {
      // 손상된 데이터는 무시
    }
  }
  return null;
}

/**
 * 현재 로그인된 사용자 데이터 조회
 * @returns {object|null}
 */
function getCurrentUserData() {
  if (!state.currentUser) return null;
  const raw = localStorage.getItem(`soundscape_user_${state.currentUser}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * 비밀번호 업데이트 (해시 + 평문 모두 갱신)
 * @returns {Promise<boolean>}
 */
async function updateUserPassword(userId, newPassword) {
  if (!userId || !newPassword) return false;
  const raw = localStorage.getItem(`soundscape_user_${userId}`);
  if (!raw) return false;
  try {
    const userData = JSON.parse(raw);
    userData.passwordHash = await sha256(newPassword);
    userData.passwordPlain = newPassword;
    localStorage.setItem(`soundscape_user_${userId}`, JSON.stringify(userData));
    return true;
  } catch (e) {
    console.error('[사운드스케이프] 비밀번호 업데이트 실패:', e);
    return false;
  }
}

/**
 * [아이디/비밀번호 찾기] 모달 열기
 * @param {'id'|'password'} mode
 */
function openFindModal(mode) {
  const modal = document.getElementById('find-modal');
  const title = document.getElementById('find-modal-title');
  const contactInput = document.getElementById('find-contact-input');
  const result = document.getElementById('find-result');
  if (!modal || !title || !contactInput || !result) return;

  if (mode === 'id') {
    title.textContent = '아이디 찾기';
  } else {
    title.textContent = '비밀번호 찾기';
  }
  contactInput.value = '';
  result.classList.add('hidden');
  result.innerHTML = '';
  modal.classList.remove('hidden');
  setTimeout(() => contactInput.focus(), 50);
}

/**
 * [아이디/비밀번호 찾기] 모달 닫기
 */
function closeFindModal() {
  const modal = document.getElementById('find-modal');
  if (modal) modal.classList.add('hidden');
}

/**
 * [아이디/비밀번호 찾기] 검색 제출
 */
function submitFind() {
  const contactInput = document.getElementById('find-contact-input');
  const result = document.getElementById('find-result');
  if (!contactInput || !result) return;

  const contact = contactInput.value.trim();
  if (!contact) {
    result.innerHTML = '<p class="find-result-error">전화번호 또는 이메일을 입력해 주세요.</p>';
    result.classList.remove('hidden');
    return;
  }

  const user = findUserByContact(contact);
  if (!user) {
    result.innerHTML = `
      <p class="find-result-error">등록된 정보를 찾을 수 없습니다.</p>
      <p class="find-result-hint">입력하신 전화번호/이메일로 가입된 계정이 없거나<br>아이디/비밀번호 찾기용 정보가 등록되지 않은 계정입니다.</p>
    `;
    result.classList.remove('hidden');
    return;
  }

  // 현재 모드(아이디/비밀번호)에 따라 다른 결과 표시
  const mode = (document.getElementById('find-modal-title') || {}).textContent || '';
  if (mode.includes('아이디')) {
    result.innerHTML = `
      <p>회원님의 아이디는</p>
      <p class="find-result-value">${escapeHtml(user.id)}</p>
      <p>입니다.</p>
    `;
  } else {
    // 비밀번호 찾기 (로컬 데모: 평문 비밀번호 표시)
    const pw = user.passwordPlain || '(평문 비밀번호 미저장 - 이전 버전 사용자)';
    result.innerHTML = `
      <p>회원님의 비밀번호는</p>
      <p class="find-result-value">${escapeHtml(pw)}</p>
      <p>입니다.</p>
      <p class="find-result-hint">⚠ 보안을 위해 비밀번호를 변경하시는 것을 권장합니다.</p>
    `;
  }
  result.classList.remove('hidden');
}

/**
 * [나의 정보] 모달 열기
 */
function openMyInfoModal() {
  if (!state.currentUser) {
    showLofiError('로그인이 필요합니다.');
    return;
  }
  const userData = getCurrentUserData();
  if (!userData) {
    showLofiError('사용자 정보를 불러올 수 없습니다.');
    return;
  }

  const idEl = document.getElementById('myinfo-id');
  const createdEl = document.getElementById('myinfo-created');
  if (idEl) idEl.textContent = userData.id;
  if (createdEl && userData.createdAt) {
    try {
      const d = new Date(userData.createdAt);
      createdEl.textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    } catch (e) {
      createdEl.textContent = userData.createdAt;
    }
  }

  // 초기 상태: 정보 보기
  myInfoVerified = false;
  showMyInfoSection('view');

  const modal = document.getElementById('myinfo-modal');
  if (modal) modal.classList.remove('hidden');
}

/**
 * [나의 정보] 모달 닫기
 */
function closeMyInfoModal() {
  const modal = document.getElementById('myinfo-modal');
  if (modal) modal.classList.add('hidden');
  myInfoVerified = false;
}

/**
 * [나의 정보] 섹션 전환 (view / verify / newpassword / success)
 */
function showMyInfoSection(name) {
  const sections = ['view', 'verify', 'newpassword', 'success'];
  sections.forEach(s => {
    const el = document.getElementById(`myinfo-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

/**
 * [나의 정보] 비밀번호 변경 시작 — 본인 인증 단계로 이동
 */
function startPasswordChange() {
  if (!state.currentUser) return;
  const userData = getCurrentUserData();
  if (!userData) return;

  // 등록된 연락처가 없으면 인증 단계로 갈 수 없음
  if (!userData.phone && !userData.email) {
    showMyInfoError('verify', '등록된 전화번호/이메일이 없습니다. 회원가입 시 등록한 정보가 있는 계정에서만 비밀번호를 변경할 수 있습니다.');
    return;
  }

  myInfoVerified = false;
  const verifyInput = document.getElementById('myinfo-verify-input');
  if (verifyInput) verifyInput.value = '';
  showMyInfoError('verify', '');
  showMyInfoSection('verify');
  setTimeout(() => verifyInput && verifyInput.focus(), 50);
}

/**
 * [나의 정보] 본인 인증 제출
 */
function submitMyInfoVerify() {
  const input = document.getElementById('myinfo-verify-input');
  if (!input) return;
  const contact = input.value.trim();
  if (!contact) {
    showMyInfoError('verify', '전화번호 또는 이메일을 입력해 주세요.');
    return;
  }

  const userData = getCurrentUserData();
  if (!userData) {
    showMyInfoError('verify', '사용자 정보를 불러올 수 없습니다.');
    return;
  }

  const contactLower = contact.toLowerCase();
  const phone = (userData.phone || '').trim();
  const email = (userData.email || '').trim().toLowerCase();

  if (phone === contact || (email && email === contactLower)) {
    myInfoVerified = true;
    const newPw = document.getElementById('myinfo-new-pw');
    const newPwConfirm = document.getElementById('myinfo-new-pw-confirm');
    if (newPw) newPw.value = '';
    if (newPwConfirm) newPwConfirm.value = '';
    showMyInfoError('pw', '');
    showMyInfoSection('newpassword');
    setTimeout(() => newPw && newPw.focus(), 50);
  } else {
    showMyInfoError('verify', '등록된 정보와 일치하지 않습니다.');
    myInfoVerified = false;
  }
}

/**
 * [나의 정보] 새 비밀번호 저장
 */
async function submitMyInfoNewPassword() {
  if (!myInfoVerified) {
    showMyInfoError('pw', '본인 인증을 먼저 완료해 주세요.');
    return;
  }
  if (!state.currentUser) return;

  const newPw = (document.getElementById('myinfo-new-pw') || {}).value || '';
  const newPwConfirm = (document.getElementById('myinfo-new-pw-confirm') || {}).value || '';

  if (newPw.length < 6) {
    showMyInfoError('pw', '비밀번호는 6자 이상이어야 합니다.');
    return;
  }
  if (newPw !== newPwConfirm) {
    showMyInfoError('pw', '비밀번호가 일치하지 않습니다.');
    return;
  }

  const success = await updateUserPassword(state.currentUser, newPw);
  if (success) {
    // [변경] lofiError 대신 모달 내부 success 섹션 표시
    myInfoVerified = false;
    showMyInfoError('pw', '');
    showMyInfoSection('success');
  } else {
    showMyInfoError('pw', '비밀번호 변경에 실패했습니다.');
  }
}

/**
 * [나의 정보] 비밀번호 변경 성공 확인 버튼 핸들러
 * - success 섹션 → view 섹션으로 복귀
 * - 비밀번호 / 인증 입력 필드 초기화 (보안)
 */
function closeMyInfoSuccess() {
  myInfoVerified = false;

  // 입력 필드 초기화 (다음 변경 시 깨끗하게 시작)
  const idsToReset = ['myinfo-new-pw', 'myinfo-new-pw-confirm', 'myinfo-verify-input'];
  idsToReset.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.value = '';
      // 비밀번호 토글이 켜져 있었다면 다시 가려두기
      if (el.type === 'text') {
        el.type = 'password';
        const toggle = document.querySelector(`.password-toggle[data-target="${id}"]`);
        if (toggle) {
          toggle.classList.remove('active');
          toggle.innerHTML = '&#128065;'; // 👁
        }
      }
    }
  });

  showMyInfoError('verify', '');
  showMyInfoError('pw', '');
  showMyInfoSection('view');
}

/**
 * [나의 정보] 비밀번호 눈 모양 표시/숨기기 토글
 * @param {string} targetId - 토글할 input의 id
 * @param {HTMLElement} btn - 클릭된 토글 버튼
 */
function togglePasswordVisibility(targetId, btn) {
  const input = document.getElementById(targetId);
  if (!input || !btn) return;
  if (input.type === 'password') {
    // 표시
    input.type = 'text';
    btn.classList.add('active');
    btn.innerHTML = '&#128584;'; // 🙈 (가려진 눈)
    btn.setAttribute('aria-label', '비밀번호 숨기기');
  } else {
    // 숨김
    input.type = 'password';
    btn.classList.remove('active');
    btn.innerHTML = '&#128065;'; // 👁 (보이는 눈)
    btn.setAttribute('aria-label', '비밀번호 표시');
  }
}

/**
 * [나의 정보] 섹션별 에러 메시지 표시
 */
function showMyInfoError(type, msg) {
  const errorEl = document.getElementById(`myinfo-${type}-error`);
  if (!errorEl) return;
  if (msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
}

/**
 * 로그인 처리
 */
async function loginUser(userId, password) {
  const userDataRaw = localStorage.getItem(`soundscape_user_${userId}`);
  if (!userDataRaw) {
    return { success: false, message: '존재하지 않는 아이디입니다.' };
  }
  const userData = JSON.parse(userDataRaw);
  const passwordHash = await sha256(password);
  if (passwordHash !== userData.passwordHash) {
    return { success: false, message: '비밀번호가 일치하지 않습니다.' };
  }
  localStorage.setItem('soundscape_session', userId);
  state.currentUser = userId;
  return { success: true, message: '로그인 성공!' };
}

/**
 * 자동 로그인 체크
 */
function initAuth() {
  const sessionId = localStorage.getItem('soundscape_session');
  if (sessionId) {
    const userDataRaw = localStorage.getItem(`soundscape_user_${sessionId}`);
    if (userDataRaw) {
      state.currentUser = sessionId;
      completeLogin(sessionId, false);
      return;
    }
    localStorage.removeItem('soundscape_session');
  }
}

/**
 * 로그인 완료 처리
 */
function completeLogin(userId, animate = true) {
  state.currentUser = userId;
  welcomeMsg.textContent = `환영합니다, ${userId}님!`;

  // [핵심] 로그인 시 localStorage에서 플레이리스트 복원
  // - initPlaylist()는 init() 시점에 user가 없을 수 있어 호출되지만,
  //   로그인/재로그인 시점에는 여기서 명시적으로 다시 호출해야 함
  loadPlaylist();
  renderPlaylist();

  if (animate) {
    authOverlay.classList.add('fade-out');
    authOverlay.addEventListener('animationend', () => {
      authOverlay.classList.add('hidden');
      appEl.classList.remove('hidden');
    }, { once: true });
  } else {
    authOverlay.classList.add('hidden');
    appEl.classList.remove('hidden');
  }
}

/**
 * 에러 메시지 표시
 */
function showAuthError(element, message) {
  element.textContent = message;
  element.classList.remove('hidden');
  setTimeout(() => {
    element.classList.add('hidden');
  }, 3000);
}

/**
 * 로그인/회원가입 폼 전환 이벤트
 */
showRegisterBtn.addEventListener('click', () => {
  loginForm.classList.add('hidden');
  registerForm.classList.remove('hidden');
  showRegisterBtn.classList.add('hidden');
  showLoginBtn.classList.remove('hidden');
});

showLoginBtn.addEventListener('click', () => {
  registerForm.classList.add('hidden');
  loginForm.classList.remove('hidden');
  showLoginBtn.classList.add('hidden');
  showRegisterBtn.classList.remove('hidden');
});

/**
 * 로그인 폼 제출 이벤트 핸들러
 */
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = loginIdInput.value.trim();
  const password = loginPwInput.value;

  if (!userId || !password) {
    showAuthError(loginError, '아이디와 비밀번호를 입력해 주세요.');
    return;
  }

  const result = await loginUser(userId, password);
  if (result.success) {
    completeLogin(userId, true);
  } else {
    showAuthError(loginError, result.message);
  }
});

/**
 * 회원가입 폼 제출 이벤트 핸들러
 */
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = registerIdInput.value.trim();
  const password = registerPwInput.value;
  const passwordConfirm = registerPwConfirmInput.value;
  const phone = (document.getElementById('register-phone') || {}).value || '';
  const email = (document.getElementById('register-email') || {}).value || '';

  if (password !== passwordConfirm) {
    showAuthError(registerError, '비밀번호가 일치하지 않습니다.');
    return;
  }

  const result = await registerUser(userId, password, phone, email);
  if (result.success) {
    showAuthError(registerError, result.message);
    setTimeout(() => {
      registerForm.classList.add('hidden');
      loginForm.classList.remove('hidden');
      showLoginBtn.classList.add('hidden');
      showRegisterBtn.classList.remove('hidden');
      registerForm.reset();
    }, 1500);
  } else {
    showAuthError(registerError, result.message);
  }
});

/**
 * 로그아웃 처리
 */
logoutBtn.addEventListener('click', () => {
  if (state.player && state.isPlayerReady) {
    try {
      state.player.stopVideo();
    } catch (e) { /* ignore */ }
  }
  localStorage.removeItem('soundscape_session');
  state.currentUser = null;
  location.reload();
});


// ============================================
// [7] AudioContext 초기화 (Audio Context Initialization)
// ============================================

/**
 * AudioContext 초기화 및 즉시 resume()
 *
 * [왜 AudioContext가 필요한가?]
 * - YouTube iframe의 오디오는 CORS 정책상 Web Audio API의 AnalyserNode로
 *   직접 분석할 수 없습니다.
 * - 하지만 AudioContext는 브라우저 오디오 잠금 해제 및
 *   향후 실제 오디오 분석을 위한 기반 역할
 * - 사용자가 곡을 클릭한 '그 순간' 즉시 resume()하여
 *   브라우저의 오디오 제한을 해제
 */
function initAudioContext() {
  /**
   * [0초 로딩 - 최상단] AudioContext.resume() 즉시 호출
   *
   * 사용자 클릭 직후 호출되므로, 어떤 상태이든 즉시 resume()을 시도합니다.
   * 이미 생성된 AudioContext가 suspended 상태면 즉시 재개하고,
   * 없으면 새로 생성 후 resume()합니다.
   */
  if (state.audioContext && state.audioContext.state === 'suspended') {
    state.audioContext.resume().catch(() => {});
  }

  if (state.audioContext) {
    return;
  }

  // AudioContext 생성 (크로스 브라우저 호환)
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: 'interactive'
  });

  // 생성 직후 즉시 resume()하여 브라우저 오디오 잠금 해제
  if (state.audioContext.state === 'suspended') {
    state.audioContext.resume().catch(() => {});
  }

  console.log('[사운드스케이프] AudioContext 초기화 완료 (즉시 resume)');
}


// ============================================
// [8] Last.fm API 검색 엔진 (Last.fm Search)
// ============================================

/**
 * Last.fm API로 음악 검색
 *
 * @param {string} query - 검색어
 */
async function searchLastfm(query) {
  if (!query || query.trim() === '') {
    showLofiError('검색어를 입력해 주세요.');
    return;
  }

  const apiUrl = `${LASTFM_API_URL}?method=track.search&api_key=${LASTFM_API_KEY}&format=json&track=${encodeURIComponent(query)}&limit=10`;

  console.log('[사운드스케이프] Last.fm 검색:', apiUrl);

  try {
    const response = await fetch(apiUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: API 호출 실패`);
    }

    const data = await response.json();
    const tracks = data.results?.trackmatches?.track;

    if (!tracks || tracks.length === 0) {
      showLofiError('검색 결과가 없습니다. 다른 키워드로 시도해 보세요.');
      lofiResultsList.innerHTML = '';
      return;
    }

    const trackArray = Array.isArray(tracks) ? tracks : [tracks];
    renderLastfmResults(trackArray);

  } catch (error) {
    console.error('[사운드스케이프] Last.fm 검색 에러:', error);
    showLofiError(`검색 실패: ${error.message}. 잠시 후 다시 시도해 주세요.`);
  }
}

/**
 * Last.fm 검색 결과를 UI에 렌더링
 *
 * 각 결과는 앨범 커버, 곡 제목, 아티스트, 청취자 수를 표시합니다.
 * 클릭 시 "lyrics/가사" 검색어로 YouTube 가사 영상을 매칭하여 재생합니다.
 */
function renderLastfmResults(tracks) {
  lofiResultsList.innerHTML = '';

  console.log(`[사운드스케이프] Last.fm 검색 결과 ${tracks.length}개 렌더링`);

  tracks.forEach((track, index) => {
    // Last.fm API 응답 구조 확인
    // track.name: 곡 제목, track.artist: 아티스트 이름
    const trackName = track.name || '';
    const artistName = track.artist || '';

    console.log(`[사운드스케이프] 결과 ${index + 1}: 아티스트="${artistName}", 곡="${trackName}"`);

    if (!trackName || !artistName) {
      console.warn(`[사운드스케이프] 결과 ${index + 1}에 곡 제목 또는 아티스트가 없습니다.`);
      return;
    }

    const albumImage = getAlbumImage(track.image);
    const listeners = parseInt(track.listeners || 0).toLocaleString();

    const listItem = document.createElement('li');
    listItem.className = 'lofi-result-item';

    listItem.innerHTML = `
      <div class="lofi-result-thumbnail">
        <img src="${albumImage}" alt="${escapeHtml(trackName)}" onerror="this.src='https://via.placeholder.com/60x60/1a1b26/7dcfff?text=♪'" />
      </div>
      <div class="lofi-result-info">
        <h4 class="lofi-result-title">${escapeHtml(trackName)}</h4>
        <p class="lofi-result-artist">${escapeHtml(artistName)}</p>
        <p class="lofi-result-meta">&#9835; ${listeners}명 청취</p>
      </div>
      <div class="lofi-result-actions">
        <button class="lofi-result-play-btn" data-track-name="${escapeHtml(trackName)}" data-artist-name="${escapeHtml(artistName)}">
          ▶ 재생
        </button>
        <button class="lofi-result-add-btn" data-track-name="${escapeHtml(trackName)}" data-artist-name="${escapeHtml(artistName)}" data-image="${escapeHtml(albumImage)}" title="플레이리스트에 추가">
          + 추가
        </button>
      </div>
    `;

    const playBtn = listItem.querySelector('.lofi-result-play-btn');
    playBtn.addEventListener('click', () => {
      console.log(`[사운드스케이프] 재생 버튼 클릭: ${artistName} - ${trackName}`);
      // 가사 영상 자동 매칭 및 즉시 재생
      autoPlayLyricsTrack(trackName, artistName);
    });

    const addBtn = listItem.querySelector('.lofi-result-add-btn');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log(`[사운드스케이프] 플레이리스트 추가 클릭: ${artistName} - ${trackName}`);
      addSearchResultToPlaylist(trackName, artistName, albumImage);
    });

    lofiResultsList.appendChild(listItem);
  });

  console.log(`[사운드스케이프] 검색 결과 렌더링 완료: ${lofiResultsList.children.length}개 항목`);
}

/**
 * Last.fm 이미지 배열에서 적절한 크기의 이미지 URL 추출
 */
function getAlbumImage(images) {
  if (!images || !Array.isArray(images) || images.length === 0) {
    return 'https://via.placeholder.com/60x60/1a1b26/7dcfff?text=♪';
  }
  const sizeOrder = ['extralarge', 'large', 'medium', 'small'];
  for (const size of sizeOrder) {
    const img = images.find(i => i.size === size);
    if (img && img['#text'] && img['#text'] !== '') {
      return img['#text'];
    }
  }
  const firstValid = images.find(i => i['#text'] && i['#text'] !== '');
  if (firstValid) {
    return firstValid['#text'];
  }
  return 'https://via.placeholder.com/60x60/1a1b26/7dcfff?text=♪';
}


// ============================================
// [9] YouTube 자동 매칭 및 즉시 재생 (100% 자동화)
// ============================================

/**
 * YouTube Data API v3로 가사 영상 자동 검색
 *
 * [공식 API 자동 매칭 흐름]
 * 1. 검색어: "{아티스트} {곡제목} 가사" (한국어 "가사" 키워드 강제 조합)
 * 2. Google 공식 엔드포인트 호출
 *    https://www.googleapis.com/youtube/v3/search
 *      ?part=snippet&type=video&videoCategoryId=10&maxResults=1
 *      &q={query}&key={YOUTUBE_API_KEY}
 * 3. 응답 JSON에서 data.items[0].id.videoId 안전 추출
 * 4. 추출한 videoId를 반환 → playYouTubeVideo()로 전달
 *
 * [왜 첫 번째 결과를 무조건 신뢰하는가?]
 * - YouTube 검색 알고리즘이 관련성 높은 영상을 상위에 배치
 * - "가사" 키워드가 포함된 검색은 자연스럽게 가사 영상이 1순위로 노출됨
 * - prompt() / 수동 입력 / 새 탭 안내 일체 없이 100% 자동화
 *
 * [통신 안전성]
 * - AbortController로 10초 타임아웃 → 무한 대기 방지
 * - 모든 네트워크 에러는 사용자 친화적 한국어 메시지로 변환
 * - "Failed to fetch" 같은 raw 영문 에러는 절대 UI에 노출되지 않음
 *
 * @param {string} trackName - 곡 제목
 * @param {string} artistName - 아티스트 이름
 * @returns {Promise<string>} YouTube videoId (예: "dQw4w9WgXcQ")
 * @throws {Error} API 키 미설정 / 타임아웃 / 검색 결과 없음 / videoId 추출 실패
 */
async function searchYouTubeLyricsVideo(trackName, artistName) {
  // 1) API 키 설정 여부 확인 (방어적 가드)
  if (!YOUTUBE_API_KEY || typeof YOUTUBE_API_KEY !== 'string' || YOUTUBE_API_KEY.length < 10) {
    throw new Error('YouTube API 키가 올바르게 설정되지 않았습니다. script.js 상단의 YOUTUBE_API_KEY 값을 확인해 주세요.');
  }

  // 2) 검색어 조합: "아티스트 곡제목 가사" (가사 영상 우선 노출)
  const query = `${artistName} ${trackName} 가사`;
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10',
    maxResults: '1',
    q: query,
    key: YOUTUBE_API_KEY
  });
  const url = `${YOUTUBE_API_URL}?${params.toString()}`;

  console.log(`[사운드스케이프] YouTube Data API v3 검색 시작: "${query}"`);

  // 3) AbortController 타임아웃 (10초) → 무한 대기 / Failed to fetch 차단
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try {
        const errData = await response.json();
        if (errData && errData.error && errData.error.message) {
          errMsg = errData.error.message;
        }
      } catch (parseErr) { /* 응답이 JSON이 아닐 수 있음 - 무시 */ }
      throw new Error(`YouTube API 호출 실패: ${errMsg}`);
    }

    const data = await response.json();

    if (!data || !data.items || !Array.isArray(data.items) || data.items.length === 0) {
      throw new Error(`"${query}"에 대한 YouTube 검색 결과가 없습니다.`);
    }

    // 4) data.items[0].id.videoId 안전 추출 (사용자 요청 핵심 경로)
    const firstItem = data.items[0];
    const videoId = firstItem && firstItem.id && firstItem.id.videoId;

    if (!videoId || typeof videoId !== 'string' || videoId.length !== 11) {
      throw new Error('YouTube 응답에서 유효한 videoId를 추출할 수 없습니다.');
    }

    console.log(`[사운드스케이프] ✓ YouTube 매칭 성공: ${videoId}`);
    return videoId;
  } catch (error) {
    clearTimeout(timeoutId);

    // [에러 변환] raw 영문 메시지를 사용자 친화적 한국어로 변환
    // "Failed to fetch" / "NetworkError" / "Load failed" 등이 UI에 그대로 노출되지 않도록 차단
    const rawMsg = (error && error.message) ? String(error.message) : '';
    const lower = rawMsg.toLowerCase();

    if (error && error.name === 'AbortError') {
      throw new Error('YouTube API 응답 시간 초과 (10초). 잠시 후 다시 시도해 주세요.');
    }
    if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed')) {
      throw new Error('YouTube API 서버에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }
    if (lower.includes('cors') || lower.includes('cross-origin')) {
      throw new Error('YouTube API CORS 정책 오류. 잠시 후 다시 시도해 주세요.');
    }

    // 그 외 에러는 원본 메시지 그대로 전달 (이미 한국어 메시지일 가능성 높음)
    throw error;
  }
}

/**
 * [0초 로딩] 곡 클릭 시 YouTube 가사 영상 자동 매칭 및 즉시 재생
 *
 * [100% 자동화 흐름 - YouTube Data API v3]
 * 1. 사용자가 곡을 클릭한 '그 순간' 호출됨 (async 함수)
 * 2. AudioContext.resume() 최상단 호출 → 브라우저 오디오 잠금 즉시 해제
 * 3. YouTube Data API v3 공식 엔드포인트로 "{아티스트} {곡제목} 가사" 검색
 *    - https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=...&key=...
 *    - API Key는 코드 내장 (사용자가 별도 입력할 필요 없음)
 * 4. 응답 JSON의 data.items[0].id.videoId 를 await 로 즉시 추출
 * 5. playYouTubeVideo(videoId, ...) → loadVideoById(videoId) 로 즉시 재생
 *
 * [수동 매칭 차단]
 * - prompt() / alert() / confirm() 등 사용자 입력 요구 UI 일체 사용 안 함
 * - "v= 값을 복사하세요" 식의 안내 얼럿 일체 출력 안 함
 * - DB 미스매치 시에도 첫 번째 검색 결과를 무조건 신뢰하고 즉시 재생
 * - 새 탭 열기(window.open)도 더 이상 사용하지 않음
 *
 * @param {string} trackName - 곡 제목
 * @param {string} artistName - 아티스트 이름
 */
async function autoPlayLyricsTrack(trackName, artistName) {
  /**
   * [0초 로딩 - 1단계] AudioContext.resume() 최상단 호출
   * 사용자가 곡을 클릭한 '그 순간' 브라우저의 오디오 잠금을 깨우기 위해
   * 가장 먼저 resume()을 호출합니다.
   */
  if (state.audioContext) {
    if (state.audioContext.state === 'suspended') {
      state.audioContext.resume().catch(() => {});
    }
  } else {
    // AudioContext가 없으면 초기화 (resume 포함)
    initAudioContext();
  }

  console.log('[사운드스케이프] ========== 가사 영상 자동 매칭 시작 ==========');
  console.log(`[사운드스케이프] 곡: "${trackName}" - 아티스트: "${artistName}"`);

  // 카드에 로딩 상태 표시
  lofiCard.classList.remove('error');
  lofiCard.classList.add('loading');
  updateLofiCardInfo(trackName, artistName);
  lofiCardArtist.textContent = `${artistName} - YouTube 검색 중...`;

  try {
    /**
     * [자동 매칭] YouTube Data API v3로 첫 번째 가사 영상 videoId 자동 추출
     * - query: "{아티스트} {곡제목} 가사"
     * - data.items[0].id.videoId 반환
     */
    const videoId = await searchYouTubeLyricsVideo(trackName, artistName);

    console.log(`[사운드스케이프] ✓ 매칭 성공 (videoId=${videoId})`);

    /**
     * [즉시 재생] 추출한 videoId를 player.loadVideoById()에 주입
     * - 0초 로딩: loadVideoById()는 로드 + 자동 재생을 한 번에 처리
     * - playYouTubeVideo 내부에서 player 준비 상태 확인 후 즉시 재생
     */
    playYouTubeVideo(videoId, trackName, artistName);
  } catch (error) {
    /**
     * [에러 처리] prompt() / alert() / window.open() 일체 사용 안 함
     * - UI 텍스트(lofiCardArtist, showLofiError)로만 자동 안내
     * - 사용자의 추가 입력은 요구하지 않음
     */
    console.error('[사운드스케이프] ✗ 자동 매칭 실패:', error);
    lofiCard.classList.add('error');
    lofiCard.classList.remove('active', 'loading');
    lofiCardTitle.textContent = trackName;
    lofiCardArtist.textContent = `${artistName} - 자동 재생 실패`;
    showLofiError(`"${artistName} - ${trackName}" 자동 재생 실패: ${error.message}`);
  }
}

/**
 * YouTube 영상 재생
 *
 * [0초 로딩 - 즉시 재생 흐름]
 * 1. AudioContext.resume() 즉시 호출 (브라우저 잠금 해제)
 * 2. YouTube Player 준비 상태 확인
 * 3. 준비 완료 시 loadVideoById() + playVideo() 즉시 호출
 * 4. 준비 미완료 시 대기 후 즉시 호출
 *
 * @param {string} videoId - YouTube 영상 ID
 * @param {string} trackName - 곡 제목
 * @param {string} artistName - 아티스트 이름
 */
function playYouTubeVideo(videoId, trackName, artistName) {
  /**
   * [0초 로딩 - 1단계] AudioContext.resume() 최상단 호출
   * 재생 버튼을 누른 '그 순간' 브라우저 오디오 잠금을 깨웁니다.
   */
  if (state.audioContext && state.audioContext.state === 'suspended') {
    state.audioContext.resume().catch(() => {});
  }

  // [race condition 복구] Player가 없거나 손상된 상태로 들어온 경우 즉시 사전 생성
  // - 새로고침 직후 첫 클릭 시 onYouTubeIframeAPIReady 콜백이 누락된 경우 대비
  if (!state.player || typeof state.player.loadVideoById !== 'function') {
    if (typeof YT !== 'undefined' && YT && YT.Player) {
      console.log('[사운드스케이프] Player 즉시 사전 생성 (재생 시점)');
      state.isYouTubeAPIReady = true;
      createYouTubePlayer();
    }
  }

  // 현재 트랙 정보 저장
  state.currentTrack = {
    videoId: videoId,
    name: trackName,
    artist: artistName
  };

  // 카드에 곡 정보 표시 (로딩 상태로)
  lofiCard.classList.remove('error');
  lofiCard.classList.add('loading');
  updateLofiCardInfo(trackName, artistName);
  updateLofiPlayButton(false); // 준비 중에는 일시정지 아이콘으로 표시하지 않음

  // 뮤직바 리셋 (새 곡 시작)
  resetProgressBar();

  // 썸네일 즉시 표시 (API 응답 기다리지 않음)
  updateLofiThumbnail(videoId);

  console.log(`[사운드스케이프] 곡 로드 시작: ${artistName} - ${trackName} (videoId: ${videoId})`);

  // YouTube Player가 준비되었는지 확인
  if (state.isPlayerReady && state.player) {
    // 즉시 영상 로드 및 재생 (0초 로딩)
    loadAndPlayImmediately(videoId);
  } else {
    // Player 준비 대기
    console.log('[사운드스케이프] YouTube Player 준비 대기 중...');
    waitForYouTubePlayer(() => {
      loadAndPlayImmediately(videoId);
    });
  }
}

/**
 * lofi-card에 YouTube 썸네일 표시
 * - hqdefault.jpg 사용 (안정적 로딩)
 * - onerror 시 maxresdefault → default 순으로 폴백
 * - 비디오 ID가 없으면 썸네일 숨김
 */
function updateLofiThumbnail(videoId) {
  const img = document.getElementById('lofi-card-thumbnail');
  if (!img) return;
  if (!videoId) {
    img.style.display = 'none';
    img.removeAttribute('src');
    return;
  }
  // 고품질 → 폴백 순서로 시도
  let tried = 0;
  const tryLoad = (url) => {
    img.style.display = 'block';
    img.src = url;
  };
  img.onload = () => {
    img.style.display = 'block';
  };
  img.onerror = () => {
    tried++;
    if (tried === 1) {
      tryLoad(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);
    } else if (tried === 2) {
      tryLoad(`https://img.youtube.com/vi/${videoId}/default.jpg`);
    } else {
      img.style.display = 'none';
    }
  };
  tryLoad(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`);
}

/**
 * 플레이리스트에서 이전 곡을 재생
 * - 현재 곡의 playlist 내 위치를 찾아 -1 위치의 곡을 재생
 * - 현재 곡이 playlist의 첫 곡이면 마지막 곡으로 wrap-around
 * - 현재 곡이 playlist에 없으면 마지막 곡 재생
 */
function playPrevInPlaylist() {
  if (state.playlist.length === 0) {
    showLofiError('플레이리스트가 비어있어 이전 곡을 재생할 수 없습니다.');
    return;
  }

  const currentVideoId = state.currentTrack && state.currentTrack.videoId;
  let prevIndex = state.playlist.length - 1;

  if (currentVideoId) {
    const currentIndex = state.playlist.findIndex(item => item.videoId === currentVideoId);
    if (currentIndex > 0) {
      prevIndex = currentIndex - 1;
    } else if (currentIndex === 0) {
      prevIndex = state.playlist.length - 1; // wrap-around
    }
    // currentIndex === -1 이면 prevIndex는 기본값(마지막) 유지
  }

  const prevTrack = state.playlist[prevIndex];
  if (!prevTrack) return;

  console.log(`[사운드스케이프] ◀ 이전 곡 재생: ${prevTrack.artist} - ${prevTrack.title} (index=${prevIndex})`);
  showLofiError(`◀ 이전 곡: ${prevTrack.artist} - ${prevTrack.title}`);
  playYouTubeVideo(prevTrack.videoId, prevTrack.title, prevTrack.artist);
}

/**
 * YouTube 영상 즉시 로드 및 재생
 *
 * @param {string} videoId - YouTube 영상 ID
 */
function loadAndPlayImmediately(videoId) {
  if (!state.player || !state.isPlayerReady) {
    console.error('[사운드스케이프] YouTube Player가 준비되지 않았습니다.');
    return;
  }

  // loadVideoById()는 영상을 로드하고 자동으로 재생을 시작합니다
  // (loadVideoById는 loadVideo + playVideo의 결합)
  state.player.loadVideoById(videoId);

  // 볼륨 설정
  const volume = state.volumes[3];
  state.player.setVolume(volume);

  // 명시적으로 playVideo() 호출하여 재생 보장
  try {
    state.player.playVideo();
  } catch (e) {
    console.warn('[사운드스케이프] playVideo() 호출 실패 (무시):', e);
  }

  // 비주얼라이저 즉시 활성화
  state.isPlaying = true;
  updateLofiPlayButton(true);
  ensureVisualizerRunning();
  updateLofiThumbnail(videoId);

  // [핵심] 뮤직바 리셋 후 다중 시점에 getDuration() 폴링
  // - YouTube IFrame API의 getDuration()은 메타데이터 로드 전까지 0 반환
  // - 0.1s / 0.4s / 1s / 2s 시점에 재시도하여 영상 길이를 가능한 한 빨리 표시
  resetProgressBar();
  startProgressUpdates();
  setTimeout(updateProgress, 100);
  setTimeout(updateProgress, 400);
  setTimeout(updateProgress, 1000);
  setTimeout(updateProgress, 2000);

  console.log(`[사운드스케이프] ✓ 즉시 재생 시작: videoId=${videoId}`);
}

// ============================================
// 뮤직바 (Music Progress Bar)
// ============================================

/** 진행률 폴링 인터벌 ID */
let progressUpdateInterval = null;
/** 진행률 폴링 간격 (ms) */
const PROGRESS_POLL_INTERVAL = 500;

/**
 * 초(seconds) → "M:SS" 문자열 변환
 */
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0 || isNaN(seconds)) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 뮤직바 폴링 시작 (500ms 간격)
 */
function startProgressUpdates() {
  stopProgressUpdates();
  progressUpdateInterval = setInterval(updateProgress, PROGRESS_POLL_INTERVAL);
}

/**
 * 뮤직바 폴링 중지
 */
function stopProgressUpdates() {
  if (progressUpdateInterval) {
    clearInterval(progressUpdateInterval);
    progressUpdateInterval = null;
  }
}

/**
 * 진행률 1회 갱신
 * - state.player.getCurrentTime() / getDuration() 사용
 */
function updateProgress() {
  if (!state.player || !state.isPlayerReady) return;

  let currentTime = 0;
  let duration = 0;
  try {
    currentTime = state.player.getCurrentTime() || 0;
    duration = state.player.getDuration() || 0;
  } catch (e) {
    // getCurrentTime() 호출 실패 시 무시
    return;
  }

  updateProgressBar(currentTime, duration);
}

/**
 * 뮤직바 DOM 직접 갱신
 * - currentTime: 항상 실제 값 표시 (재생 중 0:00 → 3:45)
 * - duration: 0 또는 NaN이면 "--:--" 표시 (영상 메타데이터 로드 전)
 *               유효한 값이 들어오면 실제 영상 길이로 표시
 * - fill width: 진행 비율 (0~100%)
 * - handle left: 진행 비율에 따라 핸들 위치 이동
 */
function updateProgressBar(currentTime, duration) {
  const fill = document.querySelector('.lofi-progress-fill');
  const handle = document.querySelector('.lofi-progress-handle');
  const current = document.querySelector('.lofi-progress-current');
  const total = document.querySelector('.lofi-progress-duration');

  if (current) current.textContent = formatTime(currentTime);
  if (total) {
    if (duration > 0 && isFinite(duration)) {
      total.textContent = formatTime(duration);
      total.style.opacity = '1';
    } else {
      total.textContent = '--:--';
      total.style.opacity = '0.5';
    }
  }
  const percent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  if (fill) fill.style.width = `${percent}%`;
  if (handle) handle.style.left = `${percent}%`;
}

/**
 * 뮤직바 초기화 (0:00 / 0% 상태로)
 */
function resetProgressBar() {
  stopProgressUpdates();
  updateProgressBar(0, 0);
}

/**
 * Progress bar 클릭 → 해당 위치로 seek
 * - 클릭 X 좌표를 progress bar 너비에 대한 비율로 변환
 * - 비율 × duration = 목표 시간 → state.player.seekTo() 호출
 * - duration이 0이면(영상 메타데이터 미로드) 동작 안 함
 */
function seekProgressBar(clickX, barWidth) {
  if (!state.player || !state.isPlayerReady) {
    console.log('[사운드스케이프] Player 준비 전 — seek 불가');
    return;
  }

  let duration = 0;
  try {
    duration = state.player.getDuration() || 0;
  } catch (e) {
    console.warn('[사운드스케이프] getDuration 실패:', e);
    return;
  }

  if (duration <= 0 || !isFinite(duration)) {
    console.log('[사운드스케이프] duration 미확보 — seek 보류');
    return;
  }

  const percent = Math.max(0, Math.min(100, (clickX / barWidth) * 100));
  const targetTime = (percent / 100) * duration;

  try {
    state.player.seekTo(targetTime, true);  // true = allowSeekAhead
    // 즉시 UI 갱신 (seek 후 getCurrentTime이 즉시 반영되도록)
    updateProgressBar(targetTime, duration);
    console.log(`[사운드스케이프] ▶ seek: ${targetTime.toFixed(1)}s / ${duration.toFixed(1)}s (${percent.toFixed(1)}%)`);
  } catch (e) {
    console.error('[사운드스케이프] seekTo 실패:', e);
  }
}

/**
 * Progress bar 클릭/드래그 이벤트 바인딩
 * - mousedown: 클릭 시 즉시 seek
 * - mousemove(드래그 중): 실시간 seek
 * - mouseup: 드래그 종료
 * - mouseleave: 드래그 종료 (바깥으로 나가면)
 */
function setupProgressBarInteraction() {
  const wrap = document.getElementById('lofi-progress-wrap');
  const bar = document.getElementById('lofi-progress-bar');
  if (!wrap || !bar) return;

  let isDragging = false;

  const handleMove = (clientX) => {
    const rect = bar.getBoundingClientRect();
    const x = clientX - rect.left;
    seekProgressBar(x, rect.width);
  };

  wrap.addEventListener('mousedown', (e) => {
    isDragging = true;
    handleMove(e.clientX);
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    handleMove(e.clientX);
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });

  document.addEventListener('mouseleave', () => {
    isDragging = false;
  });

  // 터치 디바이스 지원
  wrap.addEventListener('touchstart', (e) => {
    isDragging = true;
    if (e.touches && e.touches[0]) handleMove(e.touches[0].clientX);
    e.preventDefault();
  }, { passive: false });

  wrap.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    if (e.touches && e.touches[0]) handleMove(e.touches[0].clientX);
    e.preventDefault();
  }, { passive: false });

  wrap.addEventListener('touchend', () => {
    isDragging = false;
  });
}

/**
 * YouTube Player 준비 대기
 *
 * [동작 흐름]
 * 1. 100ms 간격으로 state.isPlayerReady 폴링
 * 2. 15초 경과 시점에 Player가 아직 null이면 재생성(createYouTubePlayer) 시도
 * 3. 30초 경과 시점까지 준비 안 되면 친절한 에러 메시지 출력
 * 4. API 스크립트 자체가 로드되지 않은 경우(isYouTubeAPIReady=false)도 별도 에러 처리
 *
 * @param {Function} callback - 준비 완료 후 실행할 콜백
 */
function waitForYouTubePlayer(callback) {
  let attempts = 0;
  const POLL_INTERVAL = 100;
  const RECREATE_AT_MS = 15000;     // 15초 시점에 Player 재생성 시도
  const TIMEOUT_MS = 30000;         // 30초 최대 대기
  const maxAttempts = Math.ceil(TIMEOUT_MS / POLL_INTERVAL);
  const recreateAt = Math.ceil(RECREATE_AT_MS / POLL_INTERVAL);
  let recreated = false;

  const checkReady = () => {
    attempts++;

    // 1) 준비 완료 → 콜백 실행
    if (state.isPlayerReady && state.player) {
      console.log(`[사운드스케이프] Player 준비 완료 (대기 ${attempts * POLL_INTERVAL}ms)`);
      callback();
      return;
    }

    // 2) API 스크립트 자체가 로드 안 된 경우 (광고 차단 / 네트워크 문제)
    if (!state.isYouTubeAPIReady) {
      if (attempts * POLL_INTERVAL >= 10000) {
        // 10초 이상 API 미로드 → 명확한 에러
        showYouTubeLoadError(
          'YouTube IFrame API 스크립트를 로드할 수 없습니다.\n' +
          '광고 차단 확장 프로그램(AdBlock, uBlock 등)을 일시중지하시거나\n' +
          '네트워크 상태를 확인한 뒤 페이지를 새로고침해 주세요.'
        );
        return;
      }
    } else if (!recreated && attempts >= recreateAt && (!state.player || typeof state.player.loadVideoById !== 'function')) {
      // 3) 15초 시점: API는 로드됐지만 Player 인스턴스가 없거나 손상됨 → 재생성 시도
      console.warn('[사운드스케이프] Player 재생성 시도 (15초 경과)');
      recreated = true;
      createYouTubePlayer();
    }

    // 4) 타임아웃
    if (attempts >= maxAttempts) {
      showYouTubeLoadError(
        'YouTube Player 로딩 시간 초과 (30초).\n' +
        '잠시 후 다시 시도하시거나 페이지를 새로고침해 주세요.'
      );
      return;
    }

    setTimeout(checkReady, POLL_INTERVAL);
  };

  checkReady();
}

/**
 * YouTube Player 로딩 실패 UI 표시 (로직 통합)
 */
function showYouTubeLoadError(detailMessage) {
  console.error('[사운드스케이프] YouTube Player 로딩 실패:', detailMessage);
  lofiCard.classList.add('error');
  lofiCard.classList.remove('active', 'loading');
  lofiCardTitle.textContent = state.currentTrack?.name || '곡';
  lofiCardArtist.textContent = 'YouTube Player 로드 실패. 잠시 후 다시 시도해 주세요.';
  showLofiError(detailMessage);
}

/**
 * 4번째 채널 카드 정보 업데이트
 */
function updateLofiCardInfo(trackName, artistName) {
  lofiCardTitle.textContent = trackName;
  lofiCardArtist.textContent = artistName;
}

/**
 * 4번째 채널 재생/일시정지 토글
 * - 1(재생) → pauseVideo()
 * - 2(일시정지) / 0(종료) / -1(미시작) / 3(버퍼링) → playVideo() 또는 loadVideoById로 재시작
 */
function toggleLofiPlayback() {
  // [0초 로딩] AudioContext.resume() 최상단 호출
  if (state.audioContext && state.audioContext.state === 'suspended') {
    state.audioContext.resume().catch(() => {});
  }

  if (!state.player || !state.isPlayerReady) {
    console.warn('[사운드스케이프] YouTube Player가 준비되지 않았습니다.');
    return;
  }

  try {
    const playerState = state.player.getPlayerState();
    // 1: 재생 중, 2: 일시정지, 0: 종료, 3: 버퍼링, -1: 미시작, 5: 큐
    if (playerState === 1) {
      // 재생 중 → 일시정지
      state.player.pauseVideo();
      state.isPlaying = false;
      updateLofiPlayButton(false);
      stopProgressUpdates();
      console.log('[사운드스케이프] ⏸ 일시정지');
    } else if (playerState === 2) {
      // 일시정지 → 재생
      state.player.playVideo();
      state.isPlaying = true;
      updateLofiPlayButton(true);
      startProgressUpdates();
      ensureVisualizerRunning();
      console.log('[사운드스케이프] ▶ 재생 재개');
    } else if (playerState === 0 || playerState === -1) {
      // 종료/미시작 → currentTrack이 있으면 해당 videoId로 재로드
      if (state.currentTrack && state.currentTrack.videoId) {
        state.player.loadVideoById(state.currentTrack.videoId);
        try { state.player.playVideo(); } catch (e) {}
        state.isPlaying = true;
        updateLofiPlayButton(true);
        startProgressUpdates();
        ensureVisualizerRunning();
        console.log('[사운드스케이프] ▶ 곡 재시작');
      }
    } else {
      // 3(버퍼링) / 5(큐) — 재생 명령만 전달
      state.player.playVideo();
      state.isPlaying = true;
      updateLofiPlayButton(true);
      startProgressUpdates();
      ensureVisualizerRunning();
    }
  } catch (e) {
    console.error('[사운드스케이프] 재생 토글 실패:', e);
  }
}

/**
 * 4번째 채널 재생 버튼 UI 업데이트
 */
function updateLofiPlayButton(playing) {
  if (playing) {
    lofiPlayBtn.classList.add('playing');
    lofiPlayIcon.innerHTML = '&#9646;&#9646;'; // 일시정지 아이콘 (⏸)
  } else {
    lofiPlayBtn.classList.remove('playing');
    lofiPlayIcon.innerHTML = '&#9654;'; // 재생 아이콘 (▶)
  }
}

/**
 * 4번째 채널 볼륨 설정
 */
function setLofiVolume(volume) {
  const clampedVolume = Math.max(0, Math.min(100, volume));
  state.volumes[3] = clampedVolume;

  // UI 업데이트
  lofiVolumeValue.textContent = clampedVolume;

  // 세로 볼륨 슬라이더의 fill 표시를 위한 CSS 변수 갱신
  // (트랙 그라데이션이 min=하단부터 max=상단까지 차오르도록)
  if (lofiVolumeSlider) {
    lofiVolumeSlider.style.setProperty('--volume-fill', `${clampedVolume}%`);
  }

  // YouTube Player 볼륨 설정
  if (state.player && state.isPlayerReady) {
    try {
      state.player.setVolume(clampedVolume);
    } catch (e) {
      console.warn('[사운드스케이프] setVolume 실패:', e);
    }
  }
}


// ============================================
// [10] YouTube IFrame Player API 초기화
// ============================================

/**
 * YouTube IFrame Player API 준비 완료 콜백
 *
 * HTML에서 <script src="https://www.youtube.com/iframe_api">를 로드하면
 * YouTube 서버에서 API 코드를 다운로드하고, 로드가 완료되면
 * 전역 함수 onYouTubeIframeAPIReady()를 자동 호출합니다.
 */
function onYouTubeIframeAPIReady() {
  console.log('[사운드스케이프] YouTube IFrame API 준비 완료');
  state.isYouTubeAPIReady = true;
  createYouTubePlayer();
}

/**
 * YouTube Player 인스턴스 생성 (재시도 가능하도록 분리)
 *
 * - API는 로드됐지만 Player 생성이 실패한 경우에도 호출 가능
 * - 광고 차단기/네트워크 문제로 실패 시 try/catch로 안전 처리
 */
function createYouTubePlayer() {
  // 컨테이너가 DOM에서 사라졌거나 YT.Player가 없으면 중단
  if (typeof YT === 'undefined' || !YT || !YT.Player) {
    console.warn('[사운드스케이프] YT.Player가 정의되지 않아 Player 생성 불가');
    state.isPlayerReady = false;
    state.player = null;
    return false;
  }
  if (!document.getElementById('yt-player-3')) {
    console.warn('[사운드스케이프] yt-player-3 컨테이너가 DOM에 없습니다.');
    return false;
  }

  // 이미 Player가 있고 살아있으면 재생성하지 않음
  if (state.player && typeof state.player.loadVideoById === 'function') {
    return true;
  }

  try {
    state.player = new YT.Player('yt-player-3', {
      width: '200',
      height: '200',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        playsinline: 1
      },
      events: {
        onReady: onYouTubePlayerReady,
        onStateChange: onYouTubePlayerStateChange,
        onError: onYouTubePlayerError
      }
    });
    console.log('[사운드스케이프] YouTube Player 인스턴스 생성 시도');
    return true;
  } catch (e) {
    console.error('[사운드스케이프] YouTube Player 생성 실패:', e);
    state.player = null;
    state.isPlayerReady = false;
    return false;
  }
}

/**
 * YouTube Player 준비 완료 핸들러
 */
function onYouTubePlayerReady(event) {
  state.isPlayerReady = true;
  // 초기 볼륨 설정
  try {
    event.target.setVolume(state.volumes[3]);
  } catch (e) {
    console.warn('[사운드스케이프] 초기 볼륨 설정 실패:', e);
  }
  console.log('[사운드스케이프] YouTube Player 준비 완료 (즉시 재생 준비 완료)');
}

/**
 * YouTube Player 상태 변경 핸들러
 *
 * 상태 코드: -1(미시작), 0(종료), 1(재생), 2(일시정지), 3(버퍼링), 5(큐)
 */
function onYouTubePlayerStateChange(event) {
  const playerState = event.data;

  if (playerState === 1) {
    // 재생 중
    state.isPlaying = true;
    updateLofiPlayButton(true);
    startProgressUpdates();
    ensureVisualizerRunning();
    updateLofiThumbnail();
  } else if (playerState === 3) {
    // 버퍼링 중 — 재생 직전이므로 진행률 폴링을 미리 시작
    // (getDuration()이 0을 반환하는 짧은 윈도우를 줄여 길이가 빨리 표시됨)
    state.isPlaying = false;
    updateLofiPlayButton(false);
    startProgressUpdates();
    ensureVisualizerRunning();
  } else if (playerState === 2) {
    // 일시정지
    state.isPlaying = false;
    updateLofiPlayButton(false);
    stopProgressUpdates();
  } else if (playerState === 0) {
    // 곡 종료
    state.isPlaying = false;
    updateLofiPlayButton(false);
    stopProgressUpdates();
    // 곡 종료 시 0:00으로 리셋
    setTimeout(resetProgressBar, 800);
    // [자동 다음 곡] 1.2초 후 플레이리스트의 다음 곡 재생
    setTimeout(() => {
      playNextInPlaylist();
    }, 1200);
  }
}

/**
 * 비주얼라이저 애니메이션 루프가 살아있는지 보장
 * - 다른 탭/최소화 후 돌아왔을 때 requestAnimationFrame이 일시정지되는 경우 대비
 */
function ensureVisualizerRunning() {
  if (state.vizAnimId === null || state.vizAnimId === undefined) {
    console.log('[사운드스케이프] 비주얼라이저 애니메이션 루프 재시작');
    state.vizAnimId = requestAnimationFrame(renderVisualizer);
  }
}

/**
 * YouTube Player 에러 핸들러
 */
function onYouTubePlayerError(event) {
  console.error('[사운드스케이프] YouTube Player 에러:', event.data);
  state.isPlaying = false;
  updateLofiPlayButton(false);
  lofiCard.classList.add('error');

  // 에러 코드별 메시지
  const errorCodes = {
    2: '잘못된 매개변수',
    5: 'HTML5 플레이어 에러',
    100: '영상을 찾을 수 없음',
    101: '임베드 재생 불가 (저작권 차단)',
    150: '임베드 재생 불가 (저작권 차단)'
  };
  const errorMsg = errorCodes[event.data] || `에러 코드: ${event.data}`;
  lofiCardTitle.textContent = state.currentTrack?.name || '곡';
  lofiCardArtist.textContent = `재생 실패: ${errorMsg}`;
  showLofiError(`재생 실패: ${errorMsg}. 다른 곡을 선택해 주세요.`);
}


// ============================================
// [11] 에러 표시 및 유틸리티
// ============================================

/**
 * Last.fm 검색 에러 메시지 표시
 */
function showLofiError(message) {
  lofiSearchError.textContent = message;
  lofiSearchError.classList.remove('hidden');
  setTimeout(() => {
    lofiSearchError.classList.add('hidden');
  }, 5000);
}

/**
 * HTML 이스케이프 (XSS 방지)
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


// ============================================
// [12] 실시간 비주얼라이저 (시뮬레이션 기반)
// ============================================

/**
 * 비주얼라이저 막대(Bar) DOM 요소 초기화
 */
function initVisualizerBars() {
  visualizerEl.innerHTML = '';
  for (let i = 0; i < VIZ_BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.classList.add('viz-bar');
    bar.style.height = '3px';
    visualizerEl.appendChild(bar);
  }
}

/**
 * 비주얼라이저 애니메이션 루프
 *
 * [시뮬레이션 비주얼라이저]
 * YouTube iframe의 오디오는 CORS 정책상 AnalyserNode로 직접 분석할 수 없습니다.
 * 따라서 재생 상태에 기반한 sin() 파동 시뮬레이션 애니메이션을 구현합니다.
 * 실제 YouTube 가사 영상 재생 시 비주얼라이저가 함께 활성화됩니다.
 *
 * [활성화 보장]
 * - state.isPlaying === true → 큰 파동 (10~200px)
 * - state.isPlaying === false → 작은 잔잔한 파동 (3~12px, 비주얼라이저가 살아있음을 시각화)
 */
function renderVisualizer() {
  const bars = visualizerEl.querySelectorAll('.viz-bar');
  if (!bars || bars.length === 0) {
    // 막대가 아직 초기화되지 않음 — 다음 프레임에 재시도
    state.vizAnimId = requestAnimationFrame(renderVisualizer);
    return;
  }

  const now = Date.now() / 1000;

  if (!state.isPlaying) {
    // [대기 모드] 매우 작은 잔잔한 파동 — 비주얼라이저가 살아있다는 시각적 신호
    for (let i = 0; i < bars.length; i++) {
      const idle = Math.sin(now * 0.8 + i * 0.25) * 0.5 + 0.5; // 0~1
      const idleHeight = 3 + idle * 9; // 3~12px
      const bar = bars[i];
      bar.style.height = `${idleHeight}px`;
      bar.style.boxShadow = `0 0 ${4 + idle * 4}px rgba(122, 162, 247, 0.25)`;
      bar.style.filter = 'brightness(0.7)';
    }
    state.vizAnimId = requestAnimationFrame(renderVisualizer);
    return;
  }

  // [재생 중] sin() 파동 + 노이즈로 dramatic한 시뮬레이션
  for (let i = 0; i < VIZ_BAR_COUNT; i++) {
    const wave1 = Math.sin(now * 1.2 + i * 0.18) * 0.5 + 0.5;
    const wave2 = Math.sin(now * 2.0 + i * 0.10 + 1.5) * 0.3 + 0.5;
    const wave3 = Math.sin(now * 3.0 + i * 0.25 + 3.0) * 0.2 + 0.5;
    let intensity = (wave1 + wave2 + wave3) / 3;
    intensity += (Math.random() - 0.5) * 0.15;
    intensity = Math.max(0.08, Math.min(1.0, intensity));

    // dramatic 스케일: 12~200px
    const heightPx = Math.max(12, intensity * 200);
    const blueGlow = Math.round(intensity * 35);
    const purpleGlow = Math.round(intensity * 28);
    const cyanGlow = Math.round(intensity * 22);

    const bar = bars[i];
    bar.style.height = `${heightPx}px`;

    if (intensity > 0.1) {
      bar.style.boxShadow = `
        0 0 ${blueGlow}px rgba(122, 162, 247, ${intensity * 0.9}),
        0 0 ${purpleGlow}px rgba(187, 154, 247, ${intensity * 0.7}),
        0 0 ${cyanGlow}px rgba(125, 207, 255, ${intensity * 0.5})
      `;
      bar.style.filter = `brightness(${1 + intensity * 1.0})`;
    } else {
      bar.style.boxShadow = 'none';
      bar.style.filter = 'brightness(1)';
    }
  }

  state.vizAnimId = requestAnimationFrame(renderVisualizer);
}


// ============================================
// [13] 플레이리스트 관리 (Playlist Management)

// ============================================

/**
 * 플레이리스트 초기화 (앱 시작 시 1회)
 * - 로그인된 사용자가 있으면 localStorage에서 복원
 * - 없으면 빈 배열로 시작
 */
function initPlaylist() {
  if (!state.currentUser) {
    state.playlist = [];
    renderPlaylist();
    return;
  }
  loadPlaylist();
  renderPlaylist();
}

/**
 * localStorage에서 플레이리스트 로드
 */
function loadPlaylist() {
  if (!state.currentUser) return;
  const key = `soundscape_playlist_${state.currentUser}`;
  const raw = localStorage.getItem(key);
  if (!raw) {
    state.playlist = [];
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.playlist = parsed.filter(isValidPlaylistItem);
    } else {
      state.playlist = [];
    }
  } catch (e) {
    console.warn('[사운드스케이프] 플레이리스트 로드 실패:', e);
    state.playlist = [];
  }
}

/**
 * localStorage에 플레이리스트 저장
 */
function savePlaylist() {
  if (!state.currentUser) return;
  const key = `soundscape_playlist_${state.currentUser}`;
  try {
    localStorage.setItem(key, JSON.stringify(state.playlist));
  } catch (e) {
    console.warn('[사운드스케이프] 플레이리스트 저장 실패:', e);
  }
}

/**
 * 플레이리스트 항목 유효성 검사
 */
function isValidPlaylistItem(item) {
  return item
    && typeof item === 'object'
    && typeof item.videoId === 'string'
    && item.videoId.length === 11
    && typeof item.title === 'string'
    && typeof item.artist === 'string';
}

/**
 * 간단한 고유 ID 생성기 (UUID 미사용, 충돌 확률 0)
 * - crypto.randomUUID가 있으면 사용, 없으면 타임스탬프+난수 fallback
 */
function generatePlaylistId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 플레이리스트에 곡 추가 (내부용)
 * - 중복 videoId는 추가하지 않음
 */
function pushToPlaylist(track) {
  if (!isValidPlaylistItem(track)) {
    console.warn('[사운드스케이프] 유효하지 않은 플레이리스트 항목:', track);
    return false;
  }
  if (state.playlist.some(item => item.videoId === track.videoId)) {
    return false; // 중복
  }
  state.playlist.push({
    id: track.id || generatePlaylistId(),
    videoId: track.videoId,
    title: track.title,
    artist: track.artist,
    thumbnail: track.thumbnail || '',
    addedAt: track.addedAt || new Date().toISOString()
  });
  savePlaylist();
  renderPlaylist();
  return true;
}

/**
 * 검색 결과의 "+ 추가" 버튼 클릭 핸들러
 * - Last.fm에서 받은 trackName/artistName으로 YouTube Data API v3 호출
 * - videoId 확보 후 플레이리스트에 추가
 */
async function addSearchResultToPlaylist(trackName, artistName, thumbnail) {
  if (!state.currentUser) {
    showLofiError('플레이리스트를 사용하려면 먼저 로그인해 주세요.');
    return;
  }
  showLofiError(`"${artistName} - ${trackName}" 플레이리스트 추가 중...`);

  try {
    const videoId = await searchYouTubeLyricsVideo(trackName, artistName);
    const added = pushToPlaylist({
      videoId: videoId,
      title: trackName,
      artist: artistName,
      thumbnail: thumbnail || ''
    });
    if (added) {
      showLofiError(`"${artistName} - ${trackName}" 플레이리스트에 추가되었습니다!`);
    } else {
      showLofiError(`"${artistName} - ${trackName}"은(는) 이미 플레이리스트에 있습니다.`);
    }
  } catch (error) {
    console.error('[사운드스케이프] 플레이리스트 추가 실패:', error);
    showLofiError(`플레이리스트 추가 실패: ${error.message}`);
  }
}

/**
 * lofi-card의 "플레이리스트에 추가" 버튼 핸들러
 * - 현재 재생 중인 track을 그대로 추가 (videoId 이미 확보됨)
 * - state.currentTrack이 비어있으면 YouTube Player의 getVideoData()로 폴백
 * - 그것도 안 되면 lofi-card의 DOM 텍스트에서 추출
 */
function addCurrentTrackToPlaylist() {
  console.log('[사운드스케이프] addCurrentTrackToPlaylist 호출', {
    currentUser: state.currentUser,
    currentTrack: state.currentTrack
  });

  // [자동 로그인 폴백] state.currentUser가 비어있으면 localStorage 세션에서 복구
  if (!state.currentUser) {
    try {
      const session = localStorage.getItem('soundscape_session');
      if (session) {
        state.currentUser = session;
        console.log('[사운드스케이프] 세션 자동 복구:', session);
      } else {
        showLofiError('플레이리스트를 사용하려면 먼저 로그인해 주세요.');
        return;
      }
    } catch (e) {
      showLofiError('플레이리스트를 사용하려면 먼저 로그인해 주세요.');
      return;
    }
  }

  // 1순위: state.currentTrack
  let videoId = state.currentTrack && state.currentTrack.videoId;
  let trackName = state.currentTrack && state.currentTrack.name;
  let artistName = state.currentTrack && state.currentTrack.artist;

  // 2순위: YouTube Player의 getVideoData() (state가 stale일 때 대비)
  if (!videoId && state.player && typeof state.player.getVideoData === 'function') {
    try {
      const data = state.player.getVideoData();
      if (data && data.video_id && data.video_id.length === 11) {
        videoId = data.video_id;
        if (!trackName && data.title) trackName = data.title;
        console.log('[사운드스케이프] videoId 폴백: getVideoData()에서 추출');
      }
    } catch (e) { /* 무시 */ }
  }

  // 3순위: lofi-card DOM 텍스트에서 추출
  if (!trackName && lofiCardTitle && lofiCardTitle.textContent && lofiCardTitle.textContent !== '검색된 곡') {
    trackName = lofiCardTitle.textContent;
    if (lofiCardArtist && lofiCardArtist.textContent) {
      artistName = lofiCardArtist.textContent.split(' - ')[0].trim() || 'Unknown';
    }
  }

  if (!videoId || videoId.length !== 11) {
    showLofiError('플레이리스트에 추가할 곡 정보가 없습니다. 곡을 먼저 재생해 주세요.');
    return;
  }

  try {
    const added = pushToPlaylist({
      videoId: videoId,
      title: trackName || 'Unknown',
      artist: artistName || 'Unknown',
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    });
    if (added) {
      showLofiError(`"${artistName || ''} - ${trackName || ''}" 플레이리스트에 추가되었습니다!`);
      flashPlaylistButton();
    } else {
      showLofiError(`"${artistName || ''} - ${trackName || ''}"은(는) 이미 플레이리스트에 있습니다.`);
    }
  } catch (e) {
    console.error('[사운드스케이프] 플레이리스트 추가 실패:', e);
    showLofiError('플레이리스트 추가 중 오류가 발생했습니다.');
  }
}

// 참고: lofi-card에서 "플레이리스트에 추가" 버튼 제거됨 (사용자 요청)
// 곡 추가는 검색 결과의 "+ 추가" 버튼에서만 가능
// addCurrentTrackToPlaylist() / flashPlaylistButton() 함수는 코드에 남겨둠 (다른 용도로 재사용 가능)
function flashPlaylistButton() {
  // 플레이리스트 추가 버튼이 lofi-card에서 제거되어 현재는 no-op
  // (검색 결과의 + 추가 버튼은 CSS hover 피드백으로 대체됨)
}

/**
 * 플레이리스트에서 항목 제거
 */
function removeFromPlaylist(itemId) {
  const before = state.playlist.length;
  state.playlist = state.playlist.filter(item => item.id !== itemId);
  if (state.playlist.length !== before) {
    savePlaylist();
    renderPlaylist();
  }
}

/**
 * 플레이리스트 전체 비우기
 */
function clearPlaylist() {
  if (state.playlist.length === 0) return;
  state.playlist = [];
  savePlaylist();
  renderPlaylist();
  showLofiError('플레이리스트를 전체 삭제했습니다.');
}

/**
 * 플레이리스트의 특정 항목 재생
 */
function playPlaylistItem(itemId) {
  const item = state.playlist.find(it => it.id === itemId);
  if (!item) return;
  // addToPlaylist에서 확보한 videoId를 그대로 재생 → 0초 추가 API 호출 없이 즉시 재생
  playYouTubeVideo(item.videoId, item.title, item.artist);
}

/**
 * 플레이리스트에서 다음 곡을 자동 재생
 * - 현재 재생 중인 곡의 playlist 내 위치를 찾아 +1 위치의 곡을 재생
 * - 현재 곡이 playlist에 없으면 첫 번째 곡 재생
 * - playlist가 비어있으면 조용히 return (사용자에게 알리지 않음)
 */
function playNextInPlaylist() {
  if (state.playlist.length === 0) {
    console.log('[사운드스케이프] 플레이리스트가 비어있어 자동 재생 건너뜀');
    return;
  }

  const currentVideoId = state.currentTrack && state.currentTrack.videoId;
  let nextIndex = 0;

  if (currentVideoId) {
    const currentIndex = state.playlist.findIndex(item => item.videoId === currentVideoId);
    if (currentIndex >= 0) {
      nextIndex = (currentIndex + 1) % state.playlist.length;
    }
  }

  const nextTrack = state.playlist[nextIndex];
  if (!nextTrack) return;

  console.log(`[사운드스케이프] ▶ 다음 곡 자동 재생: ${nextTrack.artist} - ${nextTrack.title} (index=${nextIndex})`);
  showLofiError(`▶ 다음 곡 자동 재생: ${nextTrack.artist} - ${nextTrack.title}`);
  playYouTubeVideo(nextTrack.videoId, nextTrack.title, nextTrack.artist);
}

/**
 * 플레이리스트 UI 렌더링
 */
function renderPlaylist() {
  const list = document.getElementById('playlist-list');
  const empty = document.getElementById('playlist-empty');
  const count = document.getElementById('playlist-count');
  const clearBtn = document.getElementById('clear-playlist-btn');
  if (!list) return;

  list.innerHTML = '';
  const items = state.playlist;

  if (count) {
    count.textContent = `${items.length}곡`;
  }
  if (clearBtn) {
    clearBtn.style.display = items.length === 0 ? 'none' : '';
  }
  if (empty) {
    empty.style.display = items.length === 0 ? '' : 'none';
  }

  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'playlist-item';

    const thumb = item.thumbnail && item.thumbnail.length > 0
      ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}" onerror="this.src='https://via.placeholder.com/56x56/1a1b26/7dcfff?text=♪'" />`
      : `<div class="playlist-thumb-placeholder">&#9835;</div>`;

    li.innerHTML = `
      <div class="playlist-index">${index + 1}</div>
      <div class="playlist-thumb">${thumb}</div>
      <div class="playlist-info">
        <h4 class="playlist-title">${escapeHtml(item.title)}</h4>
        <p class="playlist-artist">${escapeHtml(item.artist)}</p>
      </div>
      <div class="playlist-actions">
        <button class="playlist-play-btn" data-item-id="${escapeHtml(item.id)}" title="재생">▶</button>
        <button class="playlist-remove-btn" data-item-id="${escapeHtml(item.id)}" title="삭제">✕</button>
      </div>
    `;

    li.querySelector('.playlist-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playPlaylistItem(item.id);
    });
    li.querySelector('.playlist-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromPlaylist(item.id);
    });
    li.addEventListener('click', () => playPlaylistItem(item.id));

    list.appendChild(li);
  });
}


// ============================================
// [15] UI 이벤트 핸들러
// ============================================

/**
 * Last.fm 검색 버튼 클릭 이벤트
 */
lofiSearchBtn.addEventListener('click', () => {
  const query = lofiSearchInput.value.trim();
  searchLastfm(query);
});

/**
 * 검색 입력에서 Enter 키 처리
 */
lofiSearchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    lofiSearchBtn.click();
  }
});

/**
 * 4번째 채널 재생/일시정지 버튼 클릭 이벤트
 */
lofiPlayBtn.addEventListener('click', toggleLofiPlayback);

/**
 * 4번째 채널 볼륨 슬라이더 입력 이벤트
 */
lofiVolumeSlider.addEventListener('input', (e) => {
  const vol = parseInt(e.target.value);
  setLofiVolume(vol);
});

/**
 * lofi-card의 "이전 곡" 버튼 이벤트
 */
const lofiPrevBtn = document.getElementById('lofi-prev-btn');
if (lofiPrevBtn) {
  lofiPrevBtn.addEventListener('click', () => {
    console.log('[사운드스케이프] 이전 곡 버튼 클릭');
    playPrevInPlaylist();
  });
}

/**
 * lofi-card의 "다음 곡" 버튼 이벤트
 */
const lofiNextBtn = document.getElementById('lofi-next-btn');
if (lofiNextBtn) {
  lofiNextBtn.addEventListener('click', () => {
    console.log('[사운드스케이프] 다음 곡 버튼 클릭');
    playNextInPlaylist();
  });
}

// 참고: lofi-card에서 "플레이리스트에 추가" 버튼 제거됨 (사용자 요청)
// 곡 추가는 검색 결과의 "+ 추가" 버튼에서만 가능
// addCurrentTrackToPlaylist() / flashPlaylistButton() 함수는 코드에 남겨둠 (다른 용도로 재사용 가능)

/**
 * 플레이리스트 전체 삭제 버튼 이벤트
 */
const clearPlaylistBtn = document.getElementById('clear-playlist-btn');
if (clearPlaylistBtn) {
  clearPlaylistBtn.addEventListener('click', () => {
    if (state.playlist.length === 0) return;
    if (confirm('플레이리스트를 전체 삭제하시겠습니까?')) {
      clearPlaylist();
    }
  });
}

/**
 * 스페이스바로 재생/일시정지 토글
 * - window에 capture phase로 등록 → 다른 핸들러(YouTube iframe 등)보다 먼저 실행
 * - 입력 필드(input/textarea/contenteditable)에 포커스가 있을 때는 무시
 * - preventDefault + stopPropagation으로 페이지 스크롤/iframe 동작 차단
 */
window.addEventListener('keydown', (e) => {
  // Space 코드 (e.code='Space' / e.key=' ' / keyCode=32 모두 대응)
  const isSpace = (e.code === 'Space' || e.key === ' ' || e.keyCode === 32);
  if (!isSpace) return;

  const target = e.target;
  if (target && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  )) {
    return; // 입력란에서는 스페이스바가 정상 입력 동작
  }

  // [핵심] 페이지 스크롤 방지 + 다른 핸들러 전파 차단
  e.preventDefault();
  e.stopPropagation();

  // toggleLofiPlayback 내부에서 player 준비 상태 체크하므로
  // 준비 안 됐으면 적절한 메시지 표시 후 return
  toggleLofiPlayback();
}, true); // capture phase — iframe / 다른 핸들러보다 먼저 실행


// ============================================
// [16] 앱 초기화
// ============================================

/**
 * 앱 시작 진입점
 */
function init() {
  initVisualizerBars();
  initAuth();
  renderVisualizer();
  initPlaylist();
  setupProgressBarInteraction();  // progress bar 클릭/드래그 seek
  initCardUIVisibility();         // [신규] UI 자동 숨김/노출 (hover/click)

  // [초기 볼륨 fill 동기화] 슬라이더의 --volume-fill CSS 변수를 초기값으로 세팅
  // (트랙의 그라데이션 fill이 즉시 보이도록)
  if (lofiVolumeSlider && lofiVolumeValue) {
    lofiVolumeSlider.style.setProperty('--volume-fill', `${lofiVolumeSlider.value}%`);
    lofiVolumeValue.textContent = lofiVolumeSlider.value;
  }

  // [0초 로딩] YouTube IFrame Player 사전 생성
  tryPreCreateYouTubePlayer();
}

// ============================================
// lofi-card UI 자동 숨김/노출 (Auto-hide Controls)
// ============================================

/** UI 자동 숨김 타이머 ID */
let cardUIHideTimer = null;
/** UI 숨김 지연 (ms) — 마우스 떠난 후 0.6초 대기 */
const CARD_UI_HIDE_DELAY = 600;

/**
 * lofi-card UI를 즉시 표시
 * - 마우스 진입 OR 클릭 시 호출
 */
function showCardUI() {
  if (!lofiCard) return;
  lofiCard.classList.add('ui-visible');
  if (cardUIHideTimer) {
    clearTimeout(cardUIHideTimer);
    cardUIHideTimer = null;
  }
}

/**
 * lofi-card UI 숨김 예약 (0.6초 후)
 * - pinned 상태면 숨기지 않음
 * - 마우스 떠날 때 호출
 */
function scheduleHideCardUI() {
  if (!lofiCard) return;
  if (lofiCard.classList.contains('ui-pinned')) return;
  if (cardUIHideTimer) clearTimeout(cardUIHideTimer);
  cardUIHideTimer = setTimeout(() => {
    if (lofiCard && !lofiCard.classList.contains('ui-pinned')) {
      lofiCard.classList.remove('ui-visible');
    }
    cardUIHideTimer = null;
  }, CARD_UI_HIDE_DELAY);
}

/**
 * lofi-card UI 핀(고정) 토글
 * - 카드 본체(빈 공간) 클릭 시 호출
 * - 한 번 클릭 → ui-pinned 추가 (UI 계속 보임)
 * - 다시 클릭 → ui-pinned 제거 (자동 숨김 복귀)
 */
function toggleCardUIPin() {
  if (!lofiCard) return;
  if (lofiCard.classList.contains('ui-pinned')) {
    lofiCard.classList.remove('ui-pinned');
    lofiCard.classList.remove('ui-visible');
  } else {
    lofiCard.classList.add('ui-pinned');
    lofiCard.classList.add('ui-visible');
    if (cardUIHideTimer) {
      clearTimeout(cardUIHideTimer);
      cardUIHideTimer = null;
    }
  }
  console.log(`[사운드스케이프] UI ${lofiCard.classList.contains('ui-pinned') ? 'pinned' : 'unpinned'}`);
}

/**
 * lofi-card UI 자동 숨김/노출 이벤트 바인딩
 * - mouseenter: UI 표시
 * - mouseleave: UI 숨김 예약 (0.6초 후)
 * - click: 버튼/입력란 클릭이 아니면 핀 토글
 * 
 * [중요] 스페이스바 토글은 window capture phase로 등록되어 있으므로
 * UI가 숨겨진 상태에서도 정상 동작함 (사용자 요구사항)
 */
function initCardUIVisibility() {
  if (!lofiCard) return;

  // 마우스 진입 → UI 표시
  lofiCard.addEventListener('mouseenter', showCardUI);
  // 마우스 떠남 → UI 숨김 예약
  lofiCard.addEventListener('mouseleave', scheduleHideCardUI);

  // 클릭 → 버튼/입력란이 아니면 핀 토글
  lofiCard.addEventListener('click', (e) => {
    // 컨트롤(버튼, 슬라이더) 자체 클릭은 토글하지 않음
    if (e.target.closest('button, input')) return;
    toggleCardUIPin();
  });
}

// ============================================
// [17] 아이디/비밀번호 찾기 + 나의 정보 모달 이벤트
// ============================================

(function initFindAndMyInfoEvents() {
  // 로그인 화면: 아이디 찾기 / 비밀번호 찾기 링크
  const showFindIdBtn = document.getElementById('show-find-id-btn');
  if (showFindIdBtn) {
    showFindIdBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openFindModal('id');
    });
  }
  const showFindPasswordBtn = document.getElementById('show-find-password-btn');
  if (showFindPasswordBtn) {
    showFindPasswordBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openFindModal('password');
    });
  }

  // 찾기 모달: 제출 / 닫기 (X / 하단)
  const findSubmitBtn = document.getElementById('find-submit-btn');
  if (findSubmitBtn) {
    findSubmitBtn.addEventListener('click', submitFind);
  }
  const findContactInput = document.getElementById('find-contact-input');
  if (findContactInput) {
    findContactInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitFind();
      }
    });
  }
  const findCloseBtn = document.getElementById('find-close-btn');
  if (findCloseBtn) findCloseBtn.addEventListener('click', closeFindModal);
  const findCloseX = document.getElementById('find-close-x');
  if (findCloseX) findCloseX.addEventListener('click', closeFindModal);

  // 찾기 모달: 백드롭(어두운 영역) 클릭 시 닫기
  const findModal = document.getElementById('find-modal');
  if (findModal) {
    findModal.addEventListener('click', (e) => {
      if (e.target === findModal) closeFindModal();
    });
  }

  // 헤더: 나의 정보 버튼
  const myinfoBtn = document.getElementById('myinfo-btn');
  if (myinfoBtn) {
    myinfoBtn.addEventListener('click', openMyInfoModal);
  }

  // 나의 정보 모달: 닫기 (X / 영역 외부)
  const myinfoCloseX = document.getElementById('myinfo-close-x');
  if (myinfoCloseX) myinfoCloseX.addEventListener('click', closeMyInfoModal);
  const myinfoModal = document.getElementById('myinfo-modal');
  if (myinfoModal) {
    myinfoModal.addEventListener('click', (e) => {
      if (e.target === myinfoModal) closeMyInfoModal();
    });
  }

  // 1단계 → 2단계: 비밀번호 변경 시작
  const myinfoChangePwBtn = document.getElementById('myinfo-change-password-btn');
  if (myinfoChangePwBtn) {
    myinfoChangePwBtn.addEventListener('click', startPasswordChange);
  }

  // 2단계: 본인 인증
  const myinfoVerifyBtn = document.getElementById('myinfo-verify-btn');
  if (myinfoVerifyBtn) {
    myinfoVerifyBtn.addEventListener('click', submitMyInfoVerify);
  }
  const myinfoVerifyInput = document.getElementById('myinfo-verify-input');
  if (myinfoVerifyInput) {
    myinfoVerifyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitMyInfoVerify();
      }
    });
  }
  const myinfoVerifyCancel = document.getElementById('myinfo-verify-cancel-btn');
  if (myinfoVerifyCancel) {
    myinfoVerifyCancel.addEventListener('click', () => showMyInfoSection('view'));
  }

  // 3단계: 새 비밀번호
  const myinfoSavePwBtn = document.getElementById('myinfo-save-pw-btn');
  if (myinfoSavePwBtn) {
    myinfoSavePwBtn.addEventListener('click', submitMyInfoNewPassword);
  }
  const myinfoNewPw = document.getElementById('myinfo-new-pw');
  const myinfoNewPwConfirm = document.getElementById('myinfo-new-pw-confirm');
  const onPwEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitMyInfoNewPassword();
    }
  };
  if (myinfoNewPw) myinfoNewPw.addEventListener('keydown', onPwEnter);
  if (myinfoNewPwConfirm) myinfoNewPwConfirm.addEventListener('keydown', onPwEnter);
  const myinfoSaveCancel = document.getElementById('myinfo-save-cancel-btn');
  if (myinfoSaveCancel) {
    myinfoSaveCancel.addEventListener('click', () => showMyInfoSection('view'));
  }

  // [신규] 비밀번호 변경 성공 → 확인 버튼
  const myinfoSuccessOkBtn = document.getElementById('myinfo-success-ok-btn');
  if (myinfoSuccessOkBtn) {
    myinfoSuccessOkBtn.addEventListener('click', closeMyInfoSuccess);
  }

  // [신규] 비밀번호 눈 모양 표시/숨기기 토글 — 모든 .password-toggle 요소에 바인딩
  document.querySelectorAll('.password-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = btn.getAttribute('data-target');
      togglePasswordVisibility(targetId, btn);
    });
  });

  // ESC 키로 열린 모달 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (findModal && !findModal.classList.contains('hidden')) {
        closeFindModal();
      } else if (myinfoModal && !myinfoModal.classList.contains('hidden')) {
        closeMyInfoModal();
      }
    }
  });

  console.log('[사운드스케이프] 아이디/비밀번호 찾기 + 나의 정보 모달 이벤트 초기화 완료');
})();

/**
 * YouTube Player 사전 생성 (race condition 안전판)
 * - state.isYouTubeAPIReady === true → 즉시 생성
 * - YT 객체가 정의됐지만 플래그가 false (콜백 누락) → 플래그 세팅 후 생성
 * - 그 외 → onYouTubeIframeAPIReady 콜백이 생성 담당
 */
function tryPreCreateYouTubePlayer() {
  if (state.player && typeof state.player.loadVideoById === 'function') {
    return; // 이미 살아있는 Player가 있음
  }

  if (state.isYouTubeAPIReady) {
    createYouTubePlayer();
    return;
  }

  if (typeof YT !== 'undefined' && YT && YT.Player && document.getElementById('yt-player-3')) {
    console.log('[사운드스케이프] YouTube API 사전 감지 (콜백 누락 복구) → Player 즉시 생성');
    state.isYouTubeAPIReady = true;
    createYouTubePlayer();
  }
}

// DOM 파싱 완료 후 초기화 실행
document.addEventListener('DOMContentLoaded', init);
