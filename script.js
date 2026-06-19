/* ============================================
   Soundscape Mixer & Audio Visualizer
   YouTube IFrame Player API 기반 (script.js)

   [아키텍처 개요]
   1. 로그인 모듈: localStorage 기반 가상 세션 관리
   2. 오디오 엔진: YouTube IFrame Player API - 백그라운드 iframe 재생
   3. 비주얼라이저: 재생 상태 기반 시뮬레이션 애니메이션
   4. 타이머: setInterval 기반 카운트다운 + YouTube setVolume() 페이드아웃
   5. 프리셋: 볼륨 상태 직렬화/역직렬화 및 localStorage 영구 저장
   ============================================ */

// ============================================
// [1] 전역 상태 및 DOM 요소 참조
// ============================================

/**
 * 유튜브 채널 설정 배열
 * 각 채널은 고유한 유튜브 영상 ID를 가집니다:
 * - videoId: 유튜브 영상 고유 식별자 (URL의 v= 파라미터)
 * - name: 채널 표시 이름 (UI 및 디버깅용)
 */
const CHANNEL_CONFIG = [
  { name: '빗소리', videoId: 'q76b4-NFkOE' },
  { name: '모닥불', videoId: 'L_LUpnjgPso' },
  { name: '잔잔한 파도', videoId: 'vPhg6sc1Mk4' },
  { name: '로파이 음악', videoId: '5qap5aO4i9A' }
];

/** 비주얼라이저 막대(Bar)의 총 개수 - 시각적 해상도를 결정 */
const VIZ_BAR_COUNT = 48;

/**
 * 앱의 런타임 상태를 관리하는 전역 상태 객체
 * - players: 각 채널별 YouTube Player 인스턴스 참조
 * - playersReady: 각 채널의 플레이어 준비 완료 여부
 * - isPlaying: 각 채널의 재생 여부 불리언 배열
 * - volumes: 각 채널의 현재 볼륨 값 (0~100)
 * - timerInterval: 카운트다운 타이머의 setInterval ID
 * - fadeInterval: 페이드아웃 연산의 setInterval ID
 * - timerEndTime: 타이머 종료 예정 시점 (타임스탬프)
 * - apiReady: YouTube IFrame API 준비 완료 여부
 */
const state = {
  players: [null, null, null, null],
  playersReady: [false, false, false, false],
  isPlaying: [false, false, false, false],
  volumes: [50, 50, 50, 50],
  timerInterval: null,
  fadeInterval: null,
  timerEndTime: null,
  vizAnimId: null,
  apiReady: false
};

// --- DOM 요소 캐싱 ---
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username-input');
const appEl = document.getElementById('app');
const welcomeMsg = document.getElementById('welcome-msg');
const logoutBtn = document.getElementById('logout-btn');
const visualizerEl = document.getElementById('visualizer');
const timerDisplay = document.getElementById('timer-display');
const timerCountdown = document.getElementById('timer-countdown');
const presetStatus = document.getElementById('preset-status');
const savePresetBtn = document.getElementById('save-preset-btn');
const loadPresetBtn = document.getElementById('load-preset-btn');

const playBtns = document.querySelectorAll('.play-btn');
const volumeSliders = document.querySelectorAll('.volume-slider');
const volumeValues = document.querySelectorAll('.volume-value');
const soundCards = document.querySelectorAll('.sound-card');
const timerBtns = document.querySelectorAll('.timer-btn');


// ============================================
// [2] 로그인 모듈 (Login Module)
// ============================================

/**
 * 가상 세션 로그인 처리
 * - localStorage에서 기존 사용자 이름을 확인
 * - 있으면 자동 로그인, 없으면 모달 표시
 */
function initLogin() {
  const savedName = localStorage.getItem('soundscape_username');
  if (savedName) {
    completeLogin(savedName, false);
  }
  // 저장된 이름이 없으면 모달이 그대로 표시됨
}

/**
 * 로그인 완료 처리
 * @param {string} username - 사용자 이름
 * @param {boolean} animate - 모달 페이드아웃 애니메이션 여부
 */
function completeLogin(username, animate = true) {
  localStorage.setItem('soundscape_username', username);
  welcomeMsg.textContent = `환영합니다, ${username}님!`;

  if (animate) {
    // 모달 페이드아웃 애니메이션 후 앱 표시
    loginOverlay.classList.add('fade-out');
    loginOverlay.addEventListener('animationend', () => {
      loginOverlay.classList.add('hidden');
      appEl.classList.remove('hidden');
    }, { once: true });
  } else {
    loginOverlay.classList.add('hidden');
    appEl.classList.remove('hidden');
  }

  // 저장된 프리셋이 있으면 자동 불러오기
  loadPresetSilent();
}

/**
 * 로그인 폼 제출 이벤트 핸들러
 */
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  if (name) {
    completeLogin(name, true);
  }
});

/**
 * 로그아웃 처리
 * - localStorage에서 사용자 이름 제거
 * - 모든 오디오 정지 및 페이지 새로고침
 */
logoutBtn.addEventListener('click', () => {
  stopAllChannels();
  clearTimer();
  localStorage.removeItem('soundscape_username');
  location.reload();
});


// ============================================
// [3] YouTube IFrame Player API 엔진
// ============================================

/**
 * YouTube IFrame API 준비 완료 콜백
 *
 * [YouTube IFrame API 동작 원리]
 *
 * 1. HTML에서 <script src="https://www.youtube.com/iframe_api">를 로드하면
 *    YouTube 서버에서 API 코드를 다운로드합니다.
 *
 * 2. API 로드가 완료되면 전역 함수 onYouTubeIframeAPIReady()를 자동 호출합니다.
 *    이 함수 안에서 모든 YouTube Player 인스턴스를 생성합니다.
 *
 * 3. 각 Player는 숨겨진 <div> 컨테이너에 1x1 픽셀 iframe으로 생성되며,
 *    사용자 눈에 보이지 않는 '백그라운드 사운드 레이어'로 동작합니다.
 *
 * 4. Player 이벤트(onReady, onStateChange, onError)를 통해
 *    재생 상태, 에러 등을 감지하고 UI에 반영합니다.
 */
function onYouTubeIframeAPIReady() {
  state.apiReady = true;

  // 4개 채널의 YouTube Player를 순차적으로 생성
  for (let i = 0; i < 4; i++) {
    createYouTubePlayer(i);
  }
}

/**
 * 개별 YouTube Player 인스턴스 생성
 *
 * @param {number} channelIndex - 채널 인덱스 (0~3)
 *
 * [Player 생성 옵션 상세]
 *
 * - videoId: 재생할 유튜브 영상의 고유 ID
 * - playerVars:
 *   - autoplay: 0 (자동재생 비활성화 - 사용자가 직접 재생 버튼 클릭)
 *   - controls: 0 (재생 컨트롤바 숨김 - 백그라운드 재생이므로 불필요)
 *   - disablekb: 1 (키보드 컨트롤 비활성화)
 *   - fs: 0 (전체화면 버튼 숨김)
 *   - modestbranding: 1 (YouTube 로고 최소화)
 *   - rel: 0 (관련 영상 추천 비활성화)
 *   - origin: HTTPS 환경에서만 설정 (HTTP localhost에서는 postMessage 에러 방지)
 * - events:
 *   - onReady: 플레이어가 영상 로드 완료 시 호출
 *   - onStateChange: 재생/일시정지/종료 등 상태 변경 시 호출
 *   - onError: 에러 발생 시 호출
 *
 * [origin 파라미터와 postMessage 에러]
 *
 * YouTube IFrame API는 iframe 간 통신에 postMessage를 사용합니다.
 * 이때 origin이 HTTPS가 아닌 경우 (예: http://localhost:8080),
 * YouTube 서버가 해당 origin을 신뢰하지 않아 postMessage 에러가 발생합니다.
 *
 * 따라서 HTTPS 환경(배포 환경)에서만 origin을 명시하고,
 * HTTP localhost 환경에서는 origin을 생략하여 에러를 방지합니다.
 */
function createYouTubePlayer(channelIndex) {
  const config = CHANNEL_CONFIG[channelIndex];

  /**
   * playerVars 동적 구성
   * HTTPS 환경에서만 origin을 추가하여 postMessage origin 불일치 에러를 방지합니다.
   */
  const playerVars = {
    autoplay: 0,
    controls: 0,
    disablekb: 1,
    fs: 0,
    modestbranding: 1,
    rel: 0
  };

  // HTTPS 환경에서만 origin 설정 (localhost HTTP에서는 생략)
  if (window.location.protocol === 'https:') {
    playerVars.origin = window.location.origin;
  }

  state.players[channelIndex] = new YT.Player(`yt-player-${channelIndex}`, {
    videoId: config.videoId,
    playerVars: playerVars,
    events: {
      onReady: (event) => onPlayerReady(event, channelIndex),
      onStateChange: (event) => onPlayerStateChange(event, channelIndex),
      onError: (event) => onPlayerError(event, channelIndex)
    }
  });
}

/**
 * YouTube Player 준비 완료 핸들러
 *
 * 플레이어가 영상을 로드하고 재생 준비가 완료되면 호출됩니다.
 * 이 시점부터 playVideo(), setVolume() 등의 API 호출이 가능합니다.
 *
 * @param {YT.PlayerEvent} event - YouTube Player 이벤트 객체
 * @param {number} channelIndex - 채널 인덱스
 */
function onPlayerReady(event, channelIndex) {
  state.playersReady[channelIndex] = true;

  // 초기 볼륨 설정 (YouTube API의 볼륨 범위는 0~100)
  const initialVolume = state.volumes[channelIndex];
  event.target.setVolume(initialVolume);

  console.log(`[사운드스케이프] 채널 ${channelIndex} (${CHANNEL_CONFIG[channelIndex].name}) 플레이어 준비 완료`);
}

/**
 * YouTube Player 상태 변경 핸들러
 *
 * [YouTube Player 상태 코드]
 * -1: 시작 안 함 (unstarted)
 *  0: 종료 (ended)
 *  1: 재생 중 (playing)
 *  2: 일시정지 (paused)
 *  3: 버퍼링 (buffering)
 *  5: 동영상 큐 (video cued)
 *
 * @param {YT.OnStateChangeEvent} event - 상태 변경 이벤트
 * @param {number} channelIndex - 채널 인덱스
 */
function onPlayerStateChange(event, channelIndex) {
  const playerState = event.data;

  /**
   * 영상이 종료되면 자동으로 처음부터 다시 재생 (무한 반복)
   *
   * [루프 재생 구현 원리]
   * YouTube IFrame API에는 내장 loop 기능이 없으므로,
   * 상태가 'ENDED(0)'가 되면 seekTo(0)으로 영상을 처음으로 되감은 뒤
   * playVideo()를 호출하여 즉시 재생을 재개합니다.
   */
  if (playerState === YT.PlayerState.ENDED) {
    const player = state.players[channelIndex];
    if (player && state.isPlaying[channelIndex]) {
      player.seekTo(0, false);
      player.playVideo();
    }
  }

  /**
   * 재생/일시정지 상태를 UI와 동기화
   * 외부 요인(YouTube 자체 이벤트 등)으로 상태가 변경될 수 있으므로
   * 현재 재생 상태를 state에 반영합니다.
   */
  if (playerState === YT.PlayerState.PLAYING) {
    state.isPlaying[channelIndex] = true;
  } else if (playerState === YT.PlayerState.PAUSED) {
    state.isPlaying[channelIndex] = false;
  }
}

/**
 * YouTube Player 에러 핸들러
 *
 * [YouTube Player 에러 코드]
 *   2: 잘못된 매개변수 (invalid parameter)
 *   5: HTML5 플레이어 에러
 * 100: 영상을 찾을 수 없음 (not found)
 * 101: 임베드 재생이 허용되지 않음
 * 150: 임베드 재생이 허용되지 않음 (101과 동일)
 *
 * 에러 발생 시 해당 사운드 카드에 시각적 에러 표시를 추가하여
 * 사용자가 재생 불가 상태를 직관적으로 인지할 수 있도록 합니다.
 *
 * @param {YT.OnErrorEvent} event - 에러 이벤트
 * @param {number} channelIndex - 채널 인덱스
 */
function onPlayerError(event, channelIndex) {
  const errorCodes = {
    2: '잘못된 매개변수',
    5: 'HTML5 플레이어 에러',
    100: '영상을 찾을 수 없음',
    101: '임베드 재생 불가',
    150: '임베드 재생 불가'
  };

  const errorMsg = errorCodes[event.data] || `알 수 없는 에러 (코드: ${event.data})`;
  console.error(`[사운드스케이프] 채널 ${channelIndex} (${CHANNEL_CONFIG[channelIndex].name}) 에러: ${errorMsg}`);

  // 에러 발생 시 UI에 재생 불가 상태 표시
  state.isPlaying[channelIndex] = false;
  updatePlayButton(channelIndex, false);
  soundCards[channelIndex].classList.remove('active');

  /**
   * 카드에 에러 상태 시각적 표시
   * - 카드에 'error' CSS 클래스 추가
   * - 카드 설명 텍스트를 에러 메시지로 변경
   */
  soundCards[channelIndex].classList.add('error');
  const descEl = soundCards[channelIndex].querySelector('.card-desc');
  if (descEl) {
    descEl.textContent = `⚠ ${errorMsg}`;
    descEl.classList.add('error-text');
  }
}

/**
 * 개별 채널 재생 시작
 *
 * YouTube Player의 playVideo()를 호출하여 백그라운드 재생을 시작합니다.
 * 플레이어가 아직 준비되지 않았다면 재생 요청을 무시합니다.
 *
 * @param {number} channelIndex - 채널 인덱스 (0~3)
 */
function startChannel(channelIndex) {
  // 플레이어가 아직 준비되지 않았으면 중단
  if (!state.playersReady[channelIndex] || !state.players[channelIndex]) {
    console.warn(`[사운드스케이프] 채널 ${channelIndex} 플레이어가 아직 준비되지 않았습니다.`);
    return;
  }

  // 이미 재생 중이면 중단
  if (state.isPlaying[channelIndex]) return;

  const player = state.players[channelIndex];

  // 볼륨 재설정 (페이드아웃 후 볼륨이 0일 수 있으므로 원래 볼륨으로 복원)
  player.setVolume(state.volumes[channelIndex]);

  // YouTube 영상 재생 시작
  player.playVideo();
  state.isPlaying[channelIndex] = true;
}

/**
 * 개별 채널 정지
 *
 * YouTube Player의 pauseVideo()를 호출하여 재생을 일시정지합니다.
 * stopVideo()를 사용하지 않는 이유는 stopVideo()가 영상을 완전히 정지시켜
 * 다음 재생 시 버퍼링 지연이 발생할 수 있기 때문입니다.
 *
 * @param {number} channelIndex - 채널 인덱스 (0~3)
 */
function stopChannel(channelIndex) {
  if (!state.players[channelIndex] || !state.isPlaying[channelIndex]) return;

  const player = state.players[channelIndex];

  // YouTube 영상 일시정지
  player.pauseVideo();
  state.isPlaying[channelIndex] = false;
}

/**
 * 모든 채널 일괄 정지
 */
function stopAllChannels() {
  for (let i = 0; i < 4; i++) {
    stopChannel(i);
    updatePlayButton(i, false);
    soundCards[i].classList.remove('active');
  }
}

/**
 * 특정 채널의 볼륨 업데이트
 *
 * YouTube Player의 setVolume()을 호출하여 실시간 볼륨 변경
 * YouTube API의 볼륨 범위는 0~100이므로 슬라이더 값과 동일합니다.
 *
 * @param {number} channelIndex - 채널 인덱스
 * @param {number} volume - 볼륨 값 (0~100)
 */
function setChannelVolume(channelIndex, volume) {
  state.volumes[channelIndex] = volume;

  if (state.players[channelIndex] && state.playersReady[channelIndex]) {
    // YouTube Player에 볼륨 직접 반영 (0~100 범위)
    state.players[channelIndex].setVolume(volume);
  }
}


// ============================================
// [4] 비주얼라이저 (시뮬레이션 기반)
// ============================================

/**
 * 비주얼라이저 막대(Bar) DOM 요소 초기화
 * VIZ_BAR_COUNT 개의 div 요소를 생성하여 비주얼라이저 컨테이너에 추가합니다.
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
 * 비주얼라이저 애니메이션 루프 (시뮬레이션)
 *
 * [시뮬레이션 비주얼라이저 원리]
 *
 * YouTube IFrame API는 CORS 정책상 오디오 주파수 데이터에 접근할 수 없으므로,
 * 재생 상태를 기반으로 한 시뮬레이션 애니메이션을 구현합니다.
 *
 * 1. 재생 중인 채널 수를 확인합니다.
 * 2. 재생 중인 채널이 있으면:
 *    - 각 막대에 대해 Perlin 노이즈風の 부드러운 무작위 높이를 계산합니다.
 *    - sin() 함수와 시간 기반 오프셋을 조합하여 유기적인 움직임을 생성합니다.
 *    - 재생 중인 채널이 많을수록 전체적인 에너지가 높아집니다.
 * 3. 재생 중인 채널이 없으면:
 *    - 모든 막대를 최소 높이(3px)로 유지합니다.
 *
 * 4. requestAnimationFrame으로 다음 프레임 예약 (모니터 주사율에 동기화)
 */
function renderVisualizer() {
  const bars = visualizerEl.querySelectorAll('.viz-bar');

  // 현재 재생 중인 채널 수 계산
  const activeChannels = state.isPlaying.filter(Boolean).length;

  if (activeChannels === 0) {
    // 재생 중인 채널이 없으면 모든 막대를 최소 높이로 유지
    bars.forEach(bar => {
      bar.style.height = '3px';
      bar.style.boxShadow = 'none';
      bar.style.filter = 'brightness(1)';
    });
    state.vizAnimId = requestAnimationFrame(renderVisualizer);
    return;
  }

  /**
   * 시간 기반 시뮬레이션
   * Date.now()를 사용하여 매 프레임마다 다른 값을 생성합니다.
   * 여러 sin() 파동을 중첩하여 자연스러운 움직임을 만듭니다.
   */
  const now = Date.now() / 1000; // 초 단위의 타임스탬프
  const energy = activeChannels / 4; // 재생 채널 비율 (0.25 ~ 1.0)

  for (let i = 0; i < VIZ_BAR_COUNT; i++) {
    /**
     * 각 막대의 높이 계산
     *
     * 3개의 sin() 파동을 중첩하여 유기적인 움직임 생성:
     * - 파동 1: 막대 위치 기반 느린 파동 (0.3Hz)
     * - 파동 2: 막대 위치 기반 중간 파동 (0.7Hz)
     * - 파동 3: 막대 위치 기반 빠른 파동 (1.3Hz)
     *
     * 결과값을 0~1 범위로 정규화한 뒤 에너지 레벨을 반영합니다.
     */
    const wave1 = Math.sin(now * 0.3 + i * 0.15) * 0.5 + 0.5;
    const wave2 = Math.sin(now * 0.7 + i * 0.08 + 1.5) * 0.3 + 0.5;
    const wave3 = Math.sin(now * 1.3 + i * 0.22 + 3.0) * 0.2 + 0.5;

    // 파동 합산 및 정규화 (0.0 ~ 1.0)
    let intensity = (wave1 + wave2 + wave3) / 3;

    // 에너지 레벨 반영 (재생 채널이 많을수록 높이가 높아짐)
    intensity = intensity * (0.4 + energy * 0.6);

    // 약간의 무작위성 추가 (자연스러운 떨림 효과)
    intensity += (Math.random() - 0.5) * 0.08;
    intensity = Math.max(0.02, Math.min(1.0, intensity));

    /**
     * 막대 높이 계산
     * 최소 높이 3px을 보장하여 비재생 상태에서도 막대가 보이도록 함
     */
    const heightPx = Math.max(3, intensity * 170);

    /**
     * 색상 밝기 및 네온 효과 계산
     * 에너지 값이 높을수록:
     * - 색상이 더 밝아짐 (opacity 증가)
     * - box-shadow의 spread와 blur 반경이 커짐
     */
    const blueGlow = Math.round(intensity * 20);
    const purpleGlow = Math.round(intensity * 15);

    // 막대 스타일 동적 적용
    const bar = bars[i];
    bar.style.height = `${heightPx}px`;

    // 네온 그림자 효과: 에너지가 높을수록 강하게 번쩍임
    if (intensity > 0.1) {
      bar.style.boxShadow = `
        0 0 ${blueGlow}px rgba(122, 162, 247, ${intensity * 0.8}),
        0 0 ${purpleGlow}px rgba(187, 154, 247, ${intensity * 0.6}),
        0 0 ${blueGlow * 2}px rgba(122, 162, 247, ${intensity * 0.3})
      `;
      // 밝기 필터: 에너지가 높을수록 막대가 더 밝게 빛남
      bar.style.filter = `brightness(${1 + intensity * 0.8})`;
    } else {
      bar.style.boxShadow = 'none';
      bar.style.filter = 'brightness(1)';
    }
  }

  // 다음 프레임 예약 (일반적으로 60fps = 약 16.67ms 간격)
  state.vizAnimId = requestAnimationFrame(renderVisualizer);
}


// ============================================
// [5] 타이머 및 페이드아웃 시스템 (Timer & Fade-out)
// ============================================

/**
 * 타이머 시작
 *
 * @param {number} minutes - 타이머 지속 시간 (분)
 *
 * [페이드아웃 알고리즘 상세]
 *
 * 타이머 종료 10초 전부터 페이드아웃이 시작됩니다.
 *
 * 1. 페이드아웃 시작 시점: timerEndTime - 10초
 * 2. 페이드아웃 기간: 10,000ms (10초)
 * 3. 매 50ms마다 모든 채널의 볼륨을 YouTube setVolume()으로 선형 감소
 *
 * 수식:
 *   elapsed = 현재시각 - 페이드아웃_시작시각
 *   progress = elapsed / FADE_DURATION  (0.0 → 1.0)
 *   newVolume = originalVolume × (1 - progress)
 *
 * progress가 1.0에 도달하면 모든 볼륨이 0이 되고,
 * 이어서 모든 채널이 정지됩니다.
 */
function startTimer(minutes) {
  clearTimer(); // 기존 타이머 정리

  if (minutes <= 0) return;

  const totalMs = minutes * 60 * 1000;
  state.timerEndTime = Date.now() + totalMs;

  // 타이머 표시 UI 활성화
  timerDisplay.classList.remove('hidden');

  // 카운트다운 인터벌 (1초마다 업데이트)
  state.timerInterval = setInterval(() => {
    const remaining = state.timerEndTime - Date.now();

    if (remaining <= 0) {
      // 타이머 종료: 모든 사운드 정지
      clearTimer();
      stopAllChannels();
      resetAllSliders();
      return;
    }

    // 남은 시간을 MM:SS 형식으로 포맷팅
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerCountdown.textContent =
      `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    /**
     * 페이드아웃 시작 조건 체크
     * 남은 시간이 10초 이하이고, 아직 페이드아웃이 시작되지 않았다면 시작
     */
    if (remaining <= 10000 && !state.fadeInterval) {
      startFadeOut(remaining);
    }
  }, 200); // 200ms 간격으로 충분한 정밀도 확보
}

/**
 * 페이드아웃 실행
 *
 * @param {number} remainingMs - 페이드아웃 시작 시점의 남은 밀리초
 *
 * [페이드아웃 수학 연산]
 *
 * FADE_DURATION = 10,000ms (또는 남은 시간이 10초 미만이면 해당 시간)
 *
 * 매 FADE_INTERVAL(50ms)마다:
 *   elapsed = Date.now() - fadeStartTime
 *   progress = min(elapsed / fadeDuration, 1.0)
 *
 *   각 채널에 대해:
 *     newVol = originalVol × (1 - progress)
 *     → progress가 0일 때: newVol = originalVol (원래 볼륨)
 *     → progress가 1일 때: newVol = 0 (완전 무음)
 *
 *     YouTube Player의 setVolume()을 통해 실시간 볼륨 감소를 수행합니다.
 *     이 선형 보간(linear interpolation)을 통해
 *     사용자가 인지하기에 자연스러운 볼륨 감소를 구현합니다.
 */
function startFadeOut(remainingMs) {
  const FADE_DURATION = Math.min(remainingMs, 10000);
  const FADE_INTERVAL = 50; // 50ms마다 볼륨 업데이트 (부드러운 감소를 위해)
  const fadeStartTime = Date.now();

  // 페이드아웃 시작 시점의 각 채널 볼륨을 스냅샷 (기준값)
  const originalVolumes = [...state.volumes];

  state.fadeInterval = setInterval(() => {
    const elapsed = Date.now() - fadeStartTime;

    /**
     * 진행률 계산 (0.0 ~ 1.0)
     * Math.min으로 1.0을 초과하지 않도록 클램핑
     */
    const progress = Math.min(elapsed / FADE_DURATION, 1.0);

    // 모든 채널의 볼륨을 선형 감소
    for (let i = 0; i < 4; i++) {
      const newVol = Math.round(originalVolumes[i] * (1 - progress));

      // 슬라이더 UI 업데이트
      const slider = volumeSliders[i];
      const display = volumeValues[i];
      slider.value = newVol;
      display.textContent = newVol;

      // YouTube Player에 볼륨 반영 (setVolume API 사용)
      setChannelVolume(i, newVol);
    }

    // 페이드아웃 완료 시 모든 채널 정지
    if (progress >= 1.0) {
      clearInterval(state.fadeInterval);
      state.fadeInterval = null;
      stopAllChannels();
      resetAllSliders();
    }
  }, FADE_INTERVAL);
}

/**
 * 타이머 및 페이드아웃 정리
 */
function clearTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.fadeInterval) {
    clearInterval(state.fadeInterval);
    state.fadeInterval = null;
  }
  state.timerEndTime = null;
  timerDisplay.classList.add('hidden');
  timerCountdown.textContent = '00:00';

  // 타이머 버튼 활성 상태 해제
  timerBtns.forEach(btn => btn.classList.remove('active-timer'));
}

/**
 * 모든 슬라이더를 기본값(50)으로 리셋
 */
function resetAllSliders() {
  for (let i = 0; i < 4; i++) {
    state.volumes[i] = 50;
    volumeSliders[i].value = 50;
    volumeValues[i].textContent = '50';
  }
}


// ============================================
// [6] 프리셋 관리 (Preset Management)
// ============================================

/**
 * 현재 볼륨 프리셋 저장
 *
 * localStorage에 'soundscape_preset_[username]' 키로
 * 각 채널의 볼륨 값 배열을 JSON 문자열로 직렬화하여 저장합니다.
 */
function savePreset() {
  const username = localStorage.getItem('soundscape_username');
  if (!username) return;

  const presetData = {
    volumes: [...state.volumes],
    playing: [...state.isPlaying],
    timestamp: new Date().toISOString()
  };

  const key = `soundscape_preset_${username}`;
  localStorage.setItem(key, JSON.stringify(presetData));

  // 저장 완료 피드백 표시
  showPresetStatus('프리셋이 저장되었습니다!');
}

/**
 * 저장된 프리셋 불러오기 (사용자 피드백 포함)
 */
function loadPreset() {
  const success = loadPresetSilent();
  if (success) {
    showPresetStatus('프리셋을 불러왔습니다!');
  } else {
    showPresetStatus('저장된 프리셋이 없습니다.');
  }
}

/**
 * 저장된 프리셋을 조용히 불러오기 (자동 로그인 시 사용)
 * @returns {boolean} 불러오기 성공 여부
 */
function loadPresetSilent() {
  const username = localStorage.getItem('soundscape_username');
  if (!username) return false;

  const key = `soundscape_preset_${username}`;
  const raw = localStorage.getItem(key);
  if (!raw) return false;

  try {
    const presetData = JSON.parse(raw);

    // 볼륨 값 복원
    if (presetData.volumes && Array.isArray(presetData.volumes)) {
      for (let i = 0; i < 4; i++) {
        const vol = presetData.volumes[i] || 50;
        state.volumes[i] = vol;
        volumeSliders[i].value = vol;
        volumeValues[i].textContent = vol;

        // YouTube Player가 준비되어 있으면 볼륨 반영
        if (state.players[i] && state.playersReady[i]) {
          state.players[i].setVolume(vol);
        }
      }
    }

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 프리셋 상태 메시지 표시 (일정 시간 후 자동 사라짐)
 * @param {string} message - 표시할 메시지
 */
function showPresetStatus(message) {
  presetStatus.textContent = message;
  presetStatus.style.opacity = '1';
  setTimeout(() => {
    presetStatus.style.opacity = '0';
  }, 2500);
}


// ============================================
// [7] UI 이벤트 핸들러 바인딩
// ============================================

/**
 * 재생/일시정지 버튼 클릭 이벤트
 * 각 채널의 재생 상태를 토글하고 UI를 업데이트합니다.
 */
playBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const ch = parseInt(btn.dataset.channel);

    if (state.isPlaying[ch]) {
      stopChannel(ch);
      updatePlayButton(ch, false);
      soundCards[ch].classList.remove('active');
    } else {
      startChannel(ch);
      updatePlayButton(ch, true);
      soundCards[ch].classList.add('active');
    }
  });
});

/**
 * 재생 버튼 UI 업데이트
 * @param {number} channelIndex - 채널 인덱스
 * @param {boolean} playing - 재생 중 여부
 */
function updatePlayButton(channelIndex, playing) {
  const btn = playBtns[channelIndex];
  const icon = btn.querySelector('.play-icon');

  if (playing) {
    btn.classList.add('playing');
    icon.innerHTML = '&#9646;&#9646;'; // 일시정지 아이콘 (⏸)
  } else {
    btn.classList.remove('playing');
    icon.innerHTML = '&#9654;'; // 재생 아이콘 (▶)
  }
}

/**
 * 볼륨 슬라이더 입력 이벤트
 * 슬라이더를 움직이면 실시간으로 해당 채널의 YouTube Player 볼륨이 변경됩니다.
 */
volumeSliders.forEach(slider => {
  slider.addEventListener('input', () => {
    const ch = parseInt(slider.dataset.channel);
    const vol = parseInt(slider.value);

    // 볼륨 값 표시 업데이트
    volumeValues[ch].textContent = vol;

    // YouTube Player에 볼륨 반영
    setChannelVolume(ch, vol);
  });
});

/**
 * 타이머 버튼 클릭 이벤트
 */
timerBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const minutes = parseInt(btn.dataset.minutes);

    // 모든 타이머 버튼의 활성 상태 초기화
    timerBtns.forEach(b => b.classList.remove('active-timer'));

    if (minutes === 0) {
      // 정지 버튼: 타이머 취소
      clearTimer();
    } else {
      // 타이머 시작
      btn.classList.add('active-timer');
      startTimer(minutes);
    }
  });
});

/**
 * 프리셋 저장/불러오기 버튼 이벤트
 */
savePresetBtn.addEventListener('click', savePreset);
loadPresetBtn.addEventListener('click', loadPreset);


// ============================================
// [8] 앱 초기화 (Initialization)
// ============================================

/**
 * 앱 시작 진입점
 * 1. 비주얼라이저 막대 DOM 생성
 * 2. 로그인 상태 확인 및 UI 전환
 * 3. 비주얼라이저 애니메이션 루프 시작
 *
 * 참고: YouTube Player는 onYouTubeIframeAPIReady() 콜백에서
 * 별도로 초기화됩니다 (API 스크립트 로드 완료 시 자동 호출).
 */
function init() {
  initVisualizerBars();
  initLogin();

  // 비주얼라이저 렌더링 루프 시작
  // YouTube Player가 없어도 빈 막대를 렌더링하기 위해 즉시 시작
  renderVisualizer();
}

// DOM 파싱 완료 후 초기화 실행
document.addEventListener('DOMContentLoaded', init);
