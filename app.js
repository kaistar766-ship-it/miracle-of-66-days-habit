/*
 * 할 일 관리 앱 — 순수 Vanilla JS, 빌드 도구/프레임워크 없음 (file:// 환경에서 직접 동작).
 *
 * 파일 구성
 *   - 프로필(여러 사용자):   initProfilePicker()가 스크립트 로드 시 바로 실행되어 프로필 선택 화면을
 *                           그린다. 프로필을 고르면 enterApp(profileId)가 currentProfileId를 세팅하고
 *                           딱 한 번 initMainApp()을 호출해 기존 앱을 초기화한다. currentProfileId는
 *                           메모리에만 있어 새로고침하면 다시 프로필 선택 화면으로 돌아간다.
 *   - localStorage I/O:     loadTodos/saveTodos, loadChallenge/saveChallenge,
 *                           loadLastCategory/saveLastCategory (모두 try-catch로 감싸고
 *                           실패 시 notifyStorageError → showErrorToast로 안내). todoapp.profiles만
 *                           빼고 나머지 키는 전부 scopedKey()를 거쳐 프로필별로 분리 저장된다.
 *   - 날짜 유틸:            todayStr, dayDiff, addDays, getRecentDates (전부 로컬 시간 기준)
 *   - 할 일 CRUD:           addTodo/updateTodo/deleteTodo/toggleDone/restoreTodo (UI와 분리된 순수 함수)
 *   - 챌린지(streak) 로직:  isTodayAchieved/checkStreakOnLoad/markAchievedIfNeeded는 각각
 *                           computeAchieved/computeStreakReset/computeMarkAchieved라는 순수 계산
 *                           함수에 위임한다 — 이 compute* 함수들은 localStorage를 건드리지 않으므로
 *                           runStreakSelfTests()에서 그대로 재사용해 날짜 판정을 검증한다.
 *   - 렌더링(상태→화면):    renderTodos(목록), renderProgress(진행률), renderChallenge(스트릭/히트맵)를
 *                           renderAll()이 한 번에 호출한다. renderAll()은 실제로 할 일/챌린지
 *                           데이터가 바뀐 지점(추가/체크/삭제/실행취소/수정저장/설정저장)에서만 호출하고,
 *                           편집모드 진입처럼 데이터가 안 바뀌는 UI 상태 변경은 renderTodos()만 호출한다.
 *   - 이벤트 위임:          목록/챌린지 영역은 컨테이너 1곳에만 리스너를 등록해(initTodoListEvents,
 *                           initChallengeEvents) 매 렌더링마다 리스너가 중복 등록되지 않게 한다.
 *
 * 콘솔에서 바로 실행해 볼 수 있는 것들 (프로필을 하나 선택해 들어간 뒤): addTodo("테스트", "work"), runStreakSelfTests()
 */

/* ===== 1단계: 데이터 레이어 ===== */

var STORAGE_KEYS = {
  PROFILES: "todoapp.profiles",
  TODOS: "todoapp.todos",
  CHALLENGE: "todoapp.challenge",
  LAST_CATEGORY: "todoapp.lastCategory",
  CATEGORIES: "todoapp.categories",
};

// 프로필 개념 도입 전(단일 사용자 시절)에 저장된 데이터를 위한 특수 프로필 id.
// 이 id일 때는 키에 접미사를 붙이지 않아 기존 데이터를 그대로 읽는다 (마이그레이션 없이 호환).
var LEGACY_PROFILE_ID = "legacy";

// 현재 선택된 프로필. 메모리에만 유지한다 — 새로고침하면 프로필 선택 화면으로 돌아간다.
var currentProfileId = null;

// 프로필별로 데이터를 분리하기 위해 저장 키 뒤에 프로필 id를 붙인다.
function scopedKey(baseKey) {
  if (currentProfileId === LEGACY_PROFILE_ID) return baseKey;
  return baseKey + "." + currentProfileId;
}

/**
 * 저장/로드 실패 시 UI에 안내 메시지를 띄우기 위한 훅.
 * setStorageErrorHandler(fn)으로 5단계에서 토스트 알림과 연결한다.
 */
var storageErrorHandler = null;

function setStorageErrorHandler(fn) {
  storageErrorHandler = typeof fn === "function" ? fn : null;
}

function notifyStorageError(message) {
  if (storageErrorHandler) {
    storageErrorHandler(message);
  } else {
    console.error(message);
  }
}

function getDefaultChallenge() {
  return {
    targetDays: 30,
    rule: "min_count",
    minCount: 1,
    currentStreak: 0,
    bestStreak: 0,
    lastAchievedDate: null,
    history: [],
    startDate: todayStr(),
    stampShape: "circle",
    stampColor: "#ec4899",
    stampText: "참 잘했어요!",
  };
}

function loadTodos() {
  try {
    var raw = localStorage.getItem(scopedKey(STORAGE_KEYS.TODOS));
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    notifyStorageError("할 일 데이터를 불러오지 못했습니다.");
    return [];
  }
}

function saveTodos(todos) {
  try {
    localStorage.setItem(scopedKey(STORAGE_KEYS.TODOS), JSON.stringify(todos));
    return true;
  } catch (e) {
    notifyStorageError("저장에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.");
    return false;
  }
}

function loadChallenge() {
  try {
    var raw = localStorage.getItem(scopedKey(STORAGE_KEYS.CHALLENGE));
    if (!raw) {
      var initial = getDefaultChallenge();
      saveChallenge(initial);
      return initial;
    }
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return getDefaultChallenge();

    // 이전 버전 데이터에 없는 필드는 기본값으로 한 번만 채워 넣는다.
    var needsBackfill = false;
    if (!parsed.startDate) {
      parsed.startDate = todayStr();
      needsBackfill = true;
    }
    if (!parsed.stampShape) {
      parsed.stampShape = "circle";
      needsBackfill = true;
    }
    if (!parsed.stampColor) {
      parsed.stampColor = "#ec4899";
      needsBackfill = true;
    }
    if (!parsed.stampText) {
      parsed.stampText = "참 잘했어요!";
      needsBackfill = true;
    }
    if (needsBackfill) saveChallenge(parsed);

    return parsed;
  } catch (e) {
    notifyStorageError("챌린지 데이터를 불러오지 못했습니다.");
    return getDefaultChallenge();
  }
}

function saveChallenge(challenge) {
  try {
    localStorage.setItem(scopedKey(STORAGE_KEYS.CHALLENGE), JSON.stringify(challenge));
    return true;
  } catch (e) {
    notifyStorageError("저장에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.");
    return false;
  }
}

function loadLastCategory() {
  try {
    return localStorage.getItem(scopedKey(STORAGE_KEYS.LAST_CATEGORY)) || "work";
  } catch (e) {
    return "work";
  }
}

function saveLastCategory(category) {
  try {
    localStorage.setItem(scopedKey(STORAGE_KEYS.LAST_CATEGORY), category);
  } catch (e) {
    notifyStorageError("저장에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.");
  }
}

/* ===== 카테고리(사용자 추가 가능) ===== */

var BUILT_IN_CATEGORIES = [
  { id: "work", label: "업무", color: "#3b82f6" },
  { id: "personal", label: "개인", color: "#16a34a" },
  { id: "study", label: "공부", color: "#a855f7" },
];

// 커스텀 카테고리/프로필을 추가할 때 순서대로 골라 쓰는 공용 색상 팔레트.
var PALETTE_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#14b8a6",
  "#0ea5e9",
  "#6366f1",
  "#ec4899",
  "#64748b",
];

// 삭제할 수 없는 기본 제공 카테고리인지 여부.
function isBuiltInCategory(id) {
  return BUILT_IN_CATEGORIES.some(function (c) {
    return c.id === id;
  });
}

function pickNextPaletteColor(existingCount) {
  return PALETTE_COLORS[existingCount % PALETTE_COLORS.length];
}

// Date.now()만으로는 짧은 시간 내 연속 생성 시 id가 겹칠 수 있어 임의 문자열을 덧붙인다.
function generateId(prefix) {
  return prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

function loadCategories() {
  try {
    var raw = localStorage.getItem(scopedKey(STORAGE_KEYS.CATEGORIES));
    if (!raw) {
      saveCategories(BUILT_IN_CATEGORIES);
      return BUILT_IN_CATEGORIES.slice();
    }
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : BUILT_IN_CATEGORIES.slice();
  } catch (e) {
    notifyStorageError("카테고리 데이터를 불러오지 못했습니다.");
    return BUILT_IN_CATEGORIES.slice();
  }
}

function saveCategories(categories) {
  try {
    localStorage.setItem(scopedKey(STORAGE_KEYS.CATEGORIES), JSON.stringify(categories));
    return true;
  } catch (e) {
    notifyStorageError("저장에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.");
    return false;
  }
}

// 이름이 비어 있거나 이미 존재하면(대소문자 무시) 추가하지 않고 null을 반환한다.
function addCategory(label, color) {
  var trimmed = (label || "").trim();
  if (!trimmed) return null;

  var categories = loadCategories();
  var duplicate = categories.some(function (c) {
    return c.label.toLowerCase() === trimmed.toLowerCase();
  });
  if (duplicate) return null;

  var newCategory = {
    id: generateId("cat-"),
    label: trimmed,
    color: color || pickNextPaletteColor(categories.length),
  };
  categories.push(newCategory);
  saveCategories(categories);
  return newCategory;
}

// 기본 제공 카테고리는 삭제할 수 없다. 삭제된 카테고리를 쓰던 할 일은 기본값("work")으로 재배정한다.
function deleteCategory(id) {
  if (isBuiltInCategory(id)) return false;

  var categories = loadCategories();
  var remaining = categories.filter(function (c) {
    return c.id !== id;
  });
  if (remaining.length === categories.length) return false; // 존재하지 않는 id

  saveCategories(remaining);

  var todos = loadTodos();
  var changed = false;
  todos.forEach(function (t) {
    if (t.category === id) {
      t.category = "work";
      changed = true;
    }
  });
  if (changed) saveTodos(todos);

  if (loadLastCategory() === id) saveLastCategory("work");

  return true;
}

// "#3b82f6" + 0.14 → "rgba(59, 130, 246, 0.14)" (카테고리 태그의 은은한 배경색 계산용).
function hexToRgba(hex, alpha) {
  var clean = hex.replace("#", "");
  if (clean.length === 3) {
    clean = clean
      .split("")
      .map(function (ch) {
        return ch + ch;
      })
      .join("");
  }
  var r = parseInt(clean.substring(0, 2), 16);
  var g = parseInt(clean.substring(2, 4), 16);
  var b = parseInt(clean.substring(4, 6), 16);
  return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
}

/* ===== 날짜 유틸 (로컬 시간 기준) ===== */

function formatDateLocal(date) {
  var year = date.getFullYear();
  var month = String(date.getMonth() + 1).padStart(2, "0");
  var day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function todayStr() {
  return formatDateLocal(new Date());
}

// "YYYY-MM-DD"를 로컬 자정 기준 Date로 해석한다 (UTC 파싱으로 인한 하루 밀림 방지).
function parseDateLocal(dateStr) {
  var parts = dateStr.split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

// dateB - dateA 를 일수 차이로 반환한다 (dateB가 이후 날짜면 양수).
function dayDiff(dateA, dateB) {
  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  var a = parseDateLocal(dateA);
  var b = parseDateLocal(dateB);
  return Math.round((b - a) / MS_PER_DAY);
}

function addDays(dateStr, delta) {
  var d = parseDateLocal(dateStr);
  d.setDate(d.getDate() + delta);
  return formatDateLocal(d);
}

// today를 포함해 이전 n일치 날짜 문자열을 오래된 순으로 반환한다 (히트맵용).
function getRecentDates(n, today) {
  var dates = [];
  for (var i = n - 1; i >= 0; i--) {
    dates.push(addDays(today, -i));
  }
  return dates;
}

/* ===== 헤더 표시 정보: 습관 시작일 / 오늘의 명언 ===== */

// "YYYY-MM-DD" → "2026년 7월 5일부터 시작"
function formatStartDateLabel(dateStr) {
  var parts = dateStr.split("-");
  var year = Number(parts[0]);
  var month = Number(parts[1]);
  var day = Number(parts[2]);
  return year + "년 " + month + "월 " + day + "일부터 시작";
}

var SUCCESS_QUOTES = [
  "성공은 매일 반복되는 작은 노력들의 합이다. — 로버트 콜리어",
  "위대한 일은 갑자기 이루어지지 않는다. 작은 일들이 모여 이루어진다. — 빈센트 반 고흐",
  "습관은 처음엔 거미줄처럼 약하지만 나중엔 밧줄처럼 강해진다. — 속담",
  "동기는 시작하게 하고, 습관은 계속하게 한다. — 짐 라이언",
  "우리는 반복해서 행하는 것의 결과물이다. 탁월함은 행동이 아니라 습관이다. — 아리스토텔레스",
  "매일 1%씩 나아지면 1년 뒤 37배 성장한다. — 제임스 클리어",
  "인내는 쓰고 그 열매는 달다. — 장 자크 루소",
  "천 리 길도 한 걸음부터. — 속담",
  "탁월함은 훈련과 습관의 결과다. 우리는 행동한 대로 존재한다. — 아리스토텔레스",
  "포기하고 싶을 때가 바로 성공에 가장 가까이 왔을 때다. — 무명",
  "성공한 사람은 실패한 사람보다 조금 더 많이 시도한 사람일 뿐이다. — 토마스 에디슨",
  "오늘 걷지 않으면 내일은 뛰어야 한다. — 속담",
  "꾸준함이 재능을 이긴다. — 무명",
  "작은 습관이 결국 인생을 만든다. — 무명",
  "위대함은 한 번의 큰 도약이 아니라 작은 발걸음의 연속이다. — 무명",
  "매일 조금씩 나아지는 것, 그것이 유일한 목표여야 한다. — 무명",
  "당신이 지금 하는 행동이 당신의 미래를 결정한다. — 마하트마 간디",
  "시작이 반이다. — 아리스토텔레스",
  "물방울이 바위를 뚫는 것은 힘이 아니라 끈기다. — 오비디우스",
  "성공은 우연이 아니라 노력, 학습, 희생, 그리고 사랑의 결과다. — 펠레",
  "오늘 할 수 있는 일을 내일로 미루지 마라. — 벤저민 프랭클린",
  "습관을 바꾸면 인생이 바뀐다. — 무명",
  "매일의 작은 승리가 큰 성공을 만든다. — 무명",
  "당신의 한계는 당신의 습관이 정한다. — 무명",
  "가장 어두운 시간은 해가 뜨기 바로 직전이다. — 토마스 풀러",
  "노력은 배신하지 않는다. — 무명",
  "완벽을 기다리지 말고 지금 시작하라. — 무명",
  "작은 진전도 진전이다. — 무명",
  "끝까지 해내는 사람이 결국 이긴다. — 무명",
  "매일 최선을 다하면 오늘이 최고의 하루가 된다. — 무명",
];

// 날짜 문자열을 정수로 안정적으로 해시한다 (같은 날짜는 항상 같은 인덱스를 가리킴).
function hashStringToInt(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 1000000007;
  }
  return hash;
}

// 날짜별로 결정되는 "오늘의 명언"을 반환한다 (매일 다르게, 새로고침해도 같은 날엔 동일).
function getDailyQuote(dateStr) {
  var index = hashStringToInt(dateStr) % SUCCESS_QUOTES.length;
  return SUCCESS_QUOTES[index];
}

/* ===== 할 일 CRUD 순수 함수 (UI와 분리) ===== */

function addTodo(text, category) {
  var trimmed = (text || "").trim();
  if (!trimmed) return null;

  var todos = loadTodos();
  var newTodo = {
    id: String(Date.now()),
    text: trimmed,
    category: category,
    done: false,
    completedAt: null,
    createdAt: todayStr(),
  };
  todos.push(newTodo);
  saveTodos(todos);
  return newTodo;
}

function updateTodo(id, changes) {
  var todos = loadTodos();
  var idx = todos.findIndex(function (t) {
    return t.id === id;
  });
  if (idx === -1) return null;

  todos[idx] = Object.assign({}, todos[idx], changes);
  saveTodos(todos);
  return todos[idx];
}

function deleteTodo(id) {
  var todos = loadTodos();
  var idx = todos.findIndex(function (t) {
    return t.id === id;
  });
  if (idx === -1) return null;

  var removed = todos.splice(idx, 1)[0];
  saveTodos(todos);
  return removed;
}

function toggleDone(id) {
  var todos = loadTodos();
  var idx = todos.findIndex(function (t) {
    return t.id === id;
  });
  if (idx === -1) return null;

  var todo = todos[idx];
  todo.done = !todo.done;
  todo.completedAt = todo.done ? new Date().toISOString() : null;
  saveTodos(todos);
  return todo;
}

// 삭제 실행 취소용: 저장해 둔 원래 인덱스 위치에 항목을 다시 끼워 넣는다.
function restoreTodo(todo, index) {
  var todos = loadTodos();
  var insertAt = Math.min(Math.max(index, 0), todos.length);
  todos.splice(insertAt, 0, todo);
  saveTodos(todos);
  return todo;
}

/* ===== 4단계: 연속 달성 챌린지(streak) 로직 =====
 * 순수 계산 함수(compute*)와 localStorage I/O를 분리해서,
 * 실제 저장소를 건드리지 않고도 날짜 판정 로직을 테스트할 수 있게 한다.
 * (아래 runStreakSelfTests() 참고)
 */

var HISTORY_MAX_DAYS = 60;

// today 기준 달성 여부 순수 계산. isTodayAchieved()의 실제 구현.
function computeAchieved(todos, challenge, today) {
  var todayTodos = todos.filter(function (t) {
    return t.createdAt === today;
  });
  var completedCount = todayTodos.filter(function (t) {
    return t.done;
  }).length;

  if (challenge.rule === "all_done") {
    return todayTodos.length > 0 && completedCount === todayTodos.length;
  }
  return completedCount >= challenge.minCount; // rule === "min_count"
}

// FR-5.2: rule에 따라 오늘 달성 여부를 반환한다.
function isTodayAchieved(todos, challenge) {
  return computeAchieved(todos, challenge, todayStr());
}

// checkStreakOnLoad()의 순수 로직: lastAchievedDate와 today의 차이가 2일 이상이면
// currentStreak만 0으로 초기화한다. bestStreak/lastAchievedDate/history는 건드리지 않는다.
function computeStreakReset(challenge, today) {
  var next = Object.assign({}, challenge);
  if (next.lastAchievedDate) {
    var diff = dayDiff(next.lastAchievedDate, today);
    if (diff >= 2) {
      next.currentStreak = 0;
    }
  }
  return next;
}

// FR-5.4: 앱 실행 시 1회만 호출해야 한다 (초기화 블록에서 호출).
function checkStreakOnLoad() {
  var challenge = loadChallenge();
  var updated = computeStreakReset(challenge, todayStr());
  if (updated.currentStreak !== challenge.currentStreak) {
    saveChallenge(updated);
  }
  return updated;
}

// history는 최근 60일만 보관, 초과분은 오래된 것부터 제거한다 (오름차순 정렬 가정).
function trimHistory(history) {
  if (history.length <= HISTORY_MAX_DAYS) return history;
  return history.slice(history.length - HISTORY_MAX_DAYS);
}

// markAchievedIfNeeded()의 순수 로직.
// - 미달성 → 달성: currentStreak +1, lastAchievedDate/history 갱신, bestStreak 갱신.
// - 달성(오늘 기록됨) → 미달성: 체크 해제 등으로 조건을 다시 잃은 경우의 롤백.
//   currentStreak -1, history에서 오늘 제거, lastAchievedDate를 history의 마지막 날짜로 되돌림.
// - 그 외(상태 변화 없음): 아무 것도 하지 않는다.
function computeMarkAchieved(todos, challenge, today) {
  var next = Object.assign({}, challenge, { history: challenge.history.slice() });
  var achievedToday = computeAchieved(todos, next, today);
  var alreadyMarkedToday = next.lastAchievedDate === today;

  if (achievedToday && !alreadyMarkedToday) {
    next.currentStreak += 1;
    next.lastAchievedDate = today;
    if (next.history.indexOf(today) === -1) {
      next.history.push(today);
      next.history.sort();
    }
    next.history = trimHistory(next.history);
    next.bestStreak = Math.max(next.bestStreak, next.currentStreak);
  } else if (!achievedToday && alreadyMarkedToday) {
    next.currentStreak = Math.max(0, next.currentStreak - 1);
    var idx = next.history.indexOf(today);
    if (idx !== -1) next.history.splice(idx, 1);
    next.lastAchievedDate = next.history.length > 0 ? next.history[next.history.length - 1] : null;
  }

  return next;
}

// FR-5.4: 완료 체크(및 그로 인해 오늘 판정이 바뀔 수 있는 모든 변경) 이벤트마다 호출한다.
function markAchievedIfNeeded() {
  var challenge = loadChallenge();
  var todos = loadTodos();
  var today = todayStr();
  var updated = computeMarkAchieved(todos, challenge, today);
  saveChallenge(updated);
  return updated;
}

// 완료 확인 체크리스트를 검증하는 자가 테스트. 실제 localStorage는 건드리지 않는다.
// 브라우저 콘솔에서 runStreakSelfTests()를 직접 호출해 확인할 수 있다.
function runStreakSelfTests() {
  var results = [];
  function assert(label, condition) {
    results.push({ label: label, pass: !!condition });
  }

  // 시나리오: lastAchievedDate가 3일 전이면 currentStreak가 0이 되고 bestStreak는 유지된다.
  var challengeA = Object.assign({}, getDefaultChallenge(), {
    currentStreak: 5,
    bestStreak: 10,
    lastAchievedDate: "2024-01-01",
  });
  var resetA = computeStreakReset(challengeA, "2024-01-04");
  assert("3일 경과 시 currentStreak가 0으로 초기화된다", resetA.currentStreak === 0);
  assert("3일 경과 시에도 bestStreak는 유지된다", resetA.bestStreak === 10);

  // 시나리오: 어제(1일 차이)까지만 달성했다면 아직 초기화하지 않는다 (오늘 안에 만회 가능).
  var challengeB = Object.assign({}, getDefaultChallenge(), {
    currentStreak: 3,
    bestStreak: 3,
    lastAchievedDate: "2024-01-03",
  });
  var resetB = computeStreakReset(challengeB, "2024-01-04");
  assert("1일 차이(어제 달성)는 초기화되지 않는다", resetB.currentStreak === 3);

  // 시나리오: 오늘 첫 완료 체크 시 currentStreak +1, lastAchievedDate/history/bestStreak 갱신.
  var challengeC = Object.assign({}, getDefaultChallenge(), {
    currentStreak: 2,
    bestStreak: 2,
    lastAchievedDate: "2024-01-03",
    history: ["2024-01-02", "2024-01-03"],
  });
  var todosAchieved = [
    { id: "1", text: "t", category: "work", done: true, completedAt: "2024-01-04T00:00:00.000Z", createdAt: "2024-01-04" },
  ];
  var afterAchieve = computeMarkAchieved(todosAchieved, challengeC, "2024-01-04");
  assert("완료 체크 시 currentStreak +1", afterAchieve.currentStreak === 3);
  assert("완료 체크 시 lastAchievedDate가 오늘로 갱신된다", afterAchieve.lastAchievedDate === "2024-01-04");
  assert("완료 체크 시 bestStreak가 갱신된다", afterAchieve.bestStreak === 3);
  assert("완료 체크 시 history에 오늘이 추가된다", afterAchieve.history.indexOf("2024-01-04") !== -1);

  // 시나리오: 그 체크를 해제하면 다시 미달 상태가 되어 롤백된다 (currentStreak -1, history에서 오늘 제거).
  var todosUnachieved = [
    { id: "1", text: "t", category: "work", done: false, completedAt: null, createdAt: "2024-01-04" },
  ];
  var afterRollback = computeMarkAchieved(todosUnachieved, afterAchieve, "2024-01-04");
  assert("체크 해제 시 currentStreak가 -1 롤백된다", afterRollback.currentStreak === 2);
  assert("체크 해제 시 history에서 오늘이 제거된다", afterRollback.history.indexOf("2024-01-04") === -1);
  assert("체크 해제 후에도 bestStreak는 감소하지 않는다", afterRollback.bestStreak === 3);

  var passed = results.filter(function (r) {
    return r.pass;
  }).length;
  console.log("[streak self-test] " + passed + "/" + results.length + " passed");
  results.forEach(function (r) {
    console.log((r.pass ? "✅ " : "❌ ") + r.label);
  });

  return results;
}

/* ===== 2단계: 렌더링 (상태 → 화면 단방향) ===== */

// id → 카테고리 객체({id, label, color}) 조회용 맵을 만든다.
function buildCategoryMap(categories) {
  var map = {};
  categories.forEach(function (c) {
    map[c.id] = c;
  });
  return map;
}

// <select>에 카테고리 <option> 목록을 채운다 (추가 폼/인라인 수정 폼에서 공용으로 사용).
function populateCategorySelect(selectEl, categories, selectedId) {
  selectEl.innerHTML = "";
  categories.forEach(function (c) {
    var optionEl = document.createElement("option");
    optionEl.value = c.id;
    optionEl.textContent = c.label;
    if (c.id === selectedId) optionEl.selected = true;
    selectEl.appendChild(optionEl);
  });
}

// 현재 인라인 편집 중인 항목의 id. null이면 편집 중인 항목 없음.
var editingId = null;

// 목록 표시용 카테고리 필터. 메모리에만 유지하고 저장하지 않는다 (FR-3.3).
var currentFilter = "all";

// 챌린지 설정 폼이 열려 있는지 여부 (메모리에만 유지).
var challengeSettingsOpen = false;

// 삭제 실행 취소 대기 상태 (5초 타이머 동안만 유효)
var pendingDelete = null;
var pendingDeleteTimer = null;

// 오늘(createdAt 기준) 생성된 할 일 전체 — 필터 적용 전, 진행률 계산은 항상 이 목록 기준.
function getTodayTodos() {
  var today = todayStr();
  return loadTodos().filter(function (t) {
    return t.createdAt === today;
  });
}

function createTodoItemElement(todo, categories, categoryMap) {
  var li = document.createElement("li");
  li.className = "todo-item" + (todo.done ? " done" : "");
  li.dataset.id = todo.id;

  if (todo.id === editingId) {
    li.classList.add("editing");

    var textInput = document.createElement("input");
    textInput.type = "text";
    textInput.className = "edit-text-input";
    textInput.value = todo.text;

    var categorySelect = document.createElement("select");
    categorySelect.className = "edit-category-select";
    populateCategorySelect(categorySelect, categories, todo.category);

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "save-btn";
    saveBtn.textContent = "저장";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cancel-btn";
    cancelBtn.textContent = "취소";

    li.appendChild(textInput);
    li.appendChild(categorySelect);
    li.appendChild(saveBtn);
    li.appendChild(cancelBtn);
  } else {
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-toggle";
    checkbox.checked = todo.done;

    var category = categoryMap[todo.category] || { label: todo.category, color: "#6b7280" };
    var categoryLabel = document.createElement("span");
    categoryLabel.className = "category-tag";
    categoryLabel.style.backgroundColor = hexToRgba(category.color, 0.14);
    categoryLabel.style.color = category.color;
    categoryLabel.textContent = category.label;

    var textSpan = document.createElement("span");
    textSpan.className = "todo-text";
    textSpan.textContent = todo.text;

    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "edit-btn";
    editBtn.textContent = "✎ 수정";

    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "🗑 삭제";

    li.appendChild(checkbox);
    li.appendChild(categoryLabel);
    li.appendChild(textSpan);
    li.appendChild(editBtn);
    li.appendChild(deleteBtn);
  }

  return li;
}

// 목록 전체를 다시 그린다. 오늘 생성된 항목 중 현재 필터에 맞는 것만, 미완료 우선으로 표시한다 (FR-1.5, FR-2.2, FR-3.3).
function renderTodos() {
  var listEl = document.getElementById("todo-list");
  var categories = loadCategories();
  var categoryMap = buildCategoryMap(categories);
  var todayTodos = getTodayTodos();
  var filteredTodos =
    currentFilter === "all"
      ? todayTodos
      : todayTodos.filter(function (t) {
          return t.category === currentFilter;
        });

  var incomplete = filteredTodos.filter(function (t) {
    return !t.done;
  });
  var completed = filteredTodos.filter(function (t) {
    return t.done;
  });
  var ordered = incomplete.concat(completed);

  listEl.innerHTML = "";
  ordered.forEach(function (todo) {
    listEl.appendChild(createTodoItemElement(todo, categories, categoryMap));
  });

  if (editingId) {
    var editingLi = listEl.querySelector('.todo-item[data-id="' + CSS.escape(editingId) + '"]');
    var input = editingLi ? editingLi.querySelector(".edit-text-input") : null;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

/* ===== 3단계: 필터 + 진행률 ===== */

function updateFilterTabsUI() {
  var tabs = document.querySelectorAll("#filter-tabs .filter-tab");
  tabs.forEach(function (tab) {
    tab.classList.toggle("active", tab.dataset.filter === currentFilter);
  });
}

// "전체" 탭(고정)은 그대로 두고, 카테고리별 탭만 현재 카테고리 목록에 맞춰 다시 그린다.
function renderFilterTabs() {
  var nav = document.getElementById("filter-tabs");
  var allBtn = nav.querySelector('[data-filter="all"]');
  nav.innerHTML = "";
  nav.appendChild(allBtn);

  loadCategories().forEach(function (c) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-tab";
    btn.dataset.filter = c.id;
    btn.textContent = c.label;
    nav.appendChild(btn);
  });

  updateFilterTabsUI();
}

// 필터 탭 컨테이너에 클릭 이벤트를 위임해 붙인다 (탭 목록이 다시 그려져도 재등록되지 않도록 최초 1회만 호출).
function initFilterTabs() {
  var nav = document.getElementById("filter-tabs");
  nav.addEventListener("click", function (e) {
    var btn = e.target.closest(".filter-tab");
    if (!btn) return;
    currentFilter = btn.dataset.filter;
    updateFilterTabsUI();
    renderTodos(); // 필터는 목록 표시에만 영향을 주고 진행률은 그대로 둔다 (FR-3.3).
  });
}

// 히트맵에서 달성한 날에 보여줄 도장 모양. 특정 캐릭터를 본뜨지 않은, 직접 그린 단순 도형이다.
var STAMP_SHAPES = {
  circle: '<circle cx="50" cy="50" r="44" stroke-dasharray="3 4" /><circle cx="50" cy="50" r="36" />',
  star: '<path d="M50 6 L61 37 L94 37 L67 57 L78 90 L50 70 L22 90 L33 57 L6 37 L39 37 Z" />',
  ribbon: '<circle cx="50" cy="40" r="26" /><path d="M30 58 L18 92 L37 80 L50 92 L63 80 L82 92 L70 58" />',
  heart: '<path d="M50 88 C14 62 4 38 22 22 C36 10 50 20 50 34 C50 20 64 10 78 22 C96 38 86 62 50 88 Z" />',
};

// 히트맵 칸 안에 꽉 차게 들어가는 작은 도장 하나를 만든다 (달성한 날짜용). text는 사용자가 설정에서 직접 정한 문구.
function createHeatmapStamp(shape, color, text) {
  var wrapper = document.createElement("div");
  wrapper.className = "heatmap-stamp";
  wrapper.style.color = color;

  var shapeWrapper = document.createElement("div");
  shapeWrapper.className = "heatmap-stamp-shape";
  shapeWrapper.innerHTML =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' + (STAMP_SHAPES[shape] || STAMP_SHAPES.circle) + "</svg>";

  var label = document.createElement("span");
  label.className = "heatmap-stamp-label";
  label.textContent = text || "참 잘했어요!";

  wrapper.appendChild(shapeWrapper);
  wrapper.appendChild(label);
  return wrapper;
}

function createProgressBar(percent, colorHex) {
  var bar = document.createElement("div");
  bar.className = "progress-bar";

  var fill = document.createElement("div");
  fill.className = "progress-bar-fill";
  fill.style.width = percent + "%";
  if (colorHex) {
    fill.style.backgroundColor = colorHex;
  }

  bar.appendChild(fill);
  return bar;
}

// 전체/카테고리별 진행률을 그린다. 필터와 무관하게 항상 오늘 전체 항목 기준이다 (FR-4.1~4.3).
function renderProgress() {
  var container = document.getElementById("progress-section");
  container.innerHTML = "";

  var todayTodos = getTodayTodos();
  var total = todayTodos.length;

  if (total === 0) {
    var emptyMsg = document.createElement("p");
    emptyMsg.className = "progress-empty";
    emptyMsg.textContent = "📝 오늘의 할 일을 추가해 보세요";
    container.appendChild(emptyMsg);
    return;
  }

  var completed = todayTodos.filter(function (t) {
    return t.done;
  }).length;
  var percent = Math.round((completed / total) * 100);

  var summary = document.createElement("p");
  summary.className = "progress-summary";
  summary.textContent = "완료 " + completed + " / 전체 " + total + " (" + percent + "%)";
  container.appendChild(summary);

  var overallBar = createProgressBar(percent, null);
  overallBar.classList.add("progress-bar-overall");
  container.appendChild(overallBar);

  var categoryList = document.createElement("div");
  categoryList.className = "category-progress-list";

  loadCategories().forEach(function (cat) {
    var categoryTodos = todayTodos.filter(function (t) {
      return t.category === cat.id;
    });
    var catTotal = categoryTodos.length;
    var catCompleted = categoryTodos.filter(function (t) {
      return t.done;
    }).length;
    var catPercent = catTotal === 0 ? 0 : Math.round((catCompleted / catTotal) * 100);

    var row = document.createElement("div");
    row.className = "category-progress-row" + (catTotal === 0 ? " empty" : "");

    var label = document.createElement("span");
    label.className = "category-progress-label";
    label.textContent = cat.label + " " + catCompleted + "/" + catTotal;

    var miniBar = createProgressBar(catPercent, cat.color);
    miniBar.classList.add("progress-bar-mini");

    row.appendChild(label);
    row.appendChild(miniBar);
    categoryList.appendChild(row);
  });

  container.appendChild(categoryList);
}

/* ===== 4단계: 챌린지 UI ===== */

function createChallengeSettingsForm(challenge) {
  var form = document.createElement("div");
  form.id = "challenge-settings-form";
  form.className = "challenge-settings-form";

  var targetLabel = document.createElement("label");
  targetLabel.textContent = "목표일 수";
  var targetInput = document.createElement("input");
  targetInput.type = "number";
  targetInput.id = "settings-target-days";
  targetInput.min = "1";
  targetInput.step = "1";
  targetInput.value = challenge.targetDays;
  targetLabel.appendChild(targetInput);

  var ruleLabel = document.createElement("label");
  ruleLabel.textContent = "달성 기준";
  var ruleSelect = document.createElement("select");
  ruleSelect.id = "settings-rule-select";
  [
    { value: "all_done", label: "전부 완료" },
    { value: "min_count", label: "최소 N개 완료" },
  ].forEach(function (opt) {
    var optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    ruleSelect.appendChild(optionEl);
  });
  ruleSelect.value = challenge.rule;
  ruleLabel.appendChild(ruleSelect);

  var minCountLabel = document.createElement("label");
  minCountLabel.textContent = "N (최소 완료 개수)";
  var minCountInput = document.createElement("input");
  minCountInput.type = "number";
  minCountInput.id = "settings-min-count";
  minCountInput.min = "1";
  minCountInput.step = "1";
  minCountInput.value = challenge.minCount;
  minCountInput.disabled = challenge.rule !== "min_count";
  minCountLabel.appendChild(minCountInput);

  // rule 변경에 따라 N 입력 활성/비활성만 즉시 반영한다 (아직 저장 전이므로 폼 자체를 다시 그리지 않는다).
  ruleSelect.addEventListener("change", function () {
    minCountInput.disabled = ruleSelect.value !== "min_count";
  });

  var stampShapeLabel = document.createElement("label");
  stampShapeLabel.textContent = "오늘 100% 달성 도장 모양";
  var stampShapeSelect = document.createElement("select");
  stampShapeSelect.id = "settings-stamp-shape";
  [
    { value: "circle", label: "원형" },
    { value: "star", label: "별" },
    { value: "ribbon", label: "리본" },
    { value: "heart", label: "하트" },
  ].forEach(function (opt) {
    var optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    stampShapeSelect.appendChild(optionEl);
  });
  stampShapeSelect.value = challenge.stampShape;
  stampShapeLabel.appendChild(stampShapeSelect);

  var stampColorLabel = document.createElement("label");
  stampColorLabel.textContent = "도장 색상";
  var stampColorInput = document.createElement("input");
  stampColorInput.type = "color";
  stampColorInput.id = "settings-stamp-color";
  stampColorInput.value = challenge.stampColor;
  stampColorLabel.appendChild(stampColorInput);

  var stampTextLabel = document.createElement("label");
  stampTextLabel.textContent = "도장 문구";
  var stampTextInput = document.createElement("input");
  stampTextInput.type = "text";
  stampTextInput.id = "settings-stamp-text";
  stampTextInput.maxLength = 12;
  stampTextInput.value = challenge.stampText;
  stampTextLabel.appendChild(stampTextInput);

  form.appendChild(targetLabel);
  form.appendChild(ruleLabel);
  form.appendChild(minCountLabel);
  form.appendChild(stampShapeLabel);
  form.appendChild(stampColorLabel);
  form.appendChild(stampTextLabel);

  return form;
}

// 저장/취소 버튼이 이 필드들과 같은 폼에 있지 않고 페이지 맨 아래로 옮겨졌으므로, id로 직접 조회한다.
function saveChallengeSettingsFromInputs() {
  var targetDays = parseInt(document.getElementById("settings-target-days").value, 10);
  var minCount = parseInt(document.getElementById("settings-min-count").value, 10);
  var rule = document.getElementById("settings-rule-select").value;
  var stampShape = document.getElementById("settings-stamp-shape").value;
  var stampColor = document.getElementById("settings-stamp-color").value;
  var stampText = document.getElementById("settings-stamp-text").value.trim();

  if (!Number.isInteger(targetDays) || targetDays < 1) return;
  if (!Number.isInteger(minCount) || minCount < 1) return;
  if (!stampText) return;

  var challenge = loadChallenge();
  challenge.targetDays = targetDays;
  challenge.rule = rule;
  challenge.minCount = minCount;
  challenge.stampShape = stampShape;
  challenge.stampColor = stampColor;
  challenge.stampText = stampText;
  saveChallenge(challenge);

  challengeSettingsOpen = false;
  renderAll(); // markAchievedIfNeeded()가 새 설정 기준으로 오늘 판정/롤백을 재실행한다.
}

function cancelChallengeSettings() {
  challengeSettingsOpen = false;
  renderAll();
}

// 히트맵에 표시할 일수는 목표일 수(targetDays)를 그대로 따른다.
function getHeatmapDayCount(challenge) {
  return challenge.targetDays;
}

// 목표일 수(targetDays)에 맞춘 달성 히트맵을 순수 CSS grid로 그린다 (FR-5.5).
function createHeatmapElement(challenge) {
  var today = todayStr();
  var dates = getRecentDates(getHeatmapDayCount(challenge), today);

  var grid = document.createElement("div");
  grid.className = "heatmap-grid";

  dates.forEach(function (dateStr) {
    var cell = document.createElement("div");
    var achieved = challenge.history.indexOf(dateStr) !== -1;
    var classes = "heatmap-cell";
    if (achieved) classes += " achieved";
    if (dateStr === today) classes += " today";
    cell.className = classes;
    cell.title = dateStr;
    if (achieved) {
      cell.appendChild(createHeatmapStamp(challenge.stampShape, challenge.stampColor, challenge.stampText));
    }
    grid.appendChild(cell);
  });

  return grid;
}

// 헤더 배지 + 챌린지 영역(연속일/목표 진행바, 최고 기록, 설정 폼, 목표 달성 축하, 히트맵)을 그린다 (FR-5.1, FR-5.3, FR-5.5, FR-5.6).
function renderChallenge() {
  var challenge = loadChallenge();
  var badge = document.getElementById("streak-badge");
  badge.textContent = challenge.currentStreak > 0 ? "🔥 " + challenge.currentStreak + "일 연속" : "";

  document.getElementById("habit-start-date").textContent = formatStartDateLabel(challenge.startDate);
  document.getElementById("daily-quote").textContent = getDailyQuote(todayStr());

  var container = document.getElementById("challenge-section");
  container.innerHTML = "";

  var goalReached = challenge.currentStreak >= challenge.targetDays;

  if (goalReached) {
    var celebration = document.createElement("p");
    celebration.className = "challenge-celebration";
    celebration.textContent = "🎉 목표 " + challenge.targetDays + "일 달성! 축하합니다.";

    var newChallengeBtn = document.createElement("button");
    newChallengeBtn.type = "button";
    newChallengeBtn.id = "new-challenge-btn";
    newChallengeBtn.textContent = "새 챌린지 설정";

    container.appendChild(celebration);
    container.appendChild(newChallengeBtn);
  }

  var summary = document.createElement("p");
  summary.className = "challenge-summary";
  summary.textContent = "현재 " + challenge.currentStreak + "일 / 목표 " + challenge.targetDays + "일";

  var percent =
    challenge.targetDays > 0 ? Math.min(100, Math.round((challenge.currentStreak / challenge.targetDays) * 100)) : 0;
  var streakBar = createProgressBar(percent, null);
  streakBar.classList.add("progress-bar-challenge");

  var bestRecord = document.createElement("p");
  bestRecord.className = "challenge-best";
  bestRecord.textContent = "최고 기록: " + challenge.bestStreak + "일";

  var heatmapHeading = document.createElement("p");
  heatmapHeading.className = "heatmap-heading";
  heatmapHeading.textContent = "최근 " + getHeatmapDayCount(challenge) + "일";

  var settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.id = "challenge-settings-btn";
  settingsBtn.textContent = "⚙ 설정";

  container.appendChild(summary);
  container.appendChild(streakBar);
  container.appendChild(bestRecord);
  container.appendChild(heatmapHeading);
  container.appendChild(createHeatmapElement(challenge));
  container.appendChild(settingsBtn);

  if (challengeSettingsOpen) {
    container.appendChild(createChallengeSettingsForm(challenge));
  }

  // 자주 안 쓰는 메뉴(할 일 입력/카테고리 관리/데이터 백업/저장·취소)는 "⚙ 설정"을 열 때만 함께 노출한다.
  document.getElementById("input-section").hidden = !challengeSettingsOpen;
  document.getElementById("category-section").hidden = !challengeSettingsOpen;
  document.getElementById("backup-section").hidden = !challengeSettingsOpen;
  document.getElementById("settings-actions-section").hidden = !challengeSettingsOpen;
}

// 챌린지 영역에 이벤트를 위임해 붙인다 (렌더링마다 재등록되지 않도록 최초 1회만 호출).
function initChallengeEvents() {
  var container = document.getElementById("challenge-section");

  container.addEventListener("click", function (e) {
    if (e.target.id === "challenge-settings-btn" || e.target.id === "new-challenge-btn") {
      challengeSettingsOpen = true;
      renderChallenge();
    }
  });
}

// 페이지 맨 아래로 옮긴 저장/취소 버튼은 고정된 요소이므로 최초 1회만 리스너를 붙인다.
function initSettingsActions() {
  document.getElementById("challenge-settings-save-btn").addEventListener("click", saveChallengeSettingsFromInputs);
  document.getElementById("challenge-settings-cancel-btn").addEventListener("click", cancelChallengeSettings);
}

// 진행률(FR-4)/목록(FR-1/2/3)/챌린지(FR-5)를 함께 갱신한다. 실제로 할 일·챌린지 데이터가 바뀐 경우에만 호출한다.
function renderAll() {
  markAchievedIfNeeded();
  renderProgress();
  renderTodos();
  renderChallenge();
}

function saveEdit(id, textInput, categorySelect) {
  var trimmed = textInput.value.trim();
  if (!trimmed) return; // 빈 문자열 저장은 무시하고 편집 상태를 유지한다.
  updateTodo(id, { text: trimmed, category: categorySelect.value });
  editingId = null;
  renderAll();
}

// 단순 안내 토스트(실행취소 버튼 없음). variant는 "error" | "success" | 생략.
function showToast(message, variant) {
  var container = document.getElementById("toast-container");
  container.innerHTML = "";

  var toastEl = document.createElement("div");
  toastEl.className = "toast" + (variant ? " toast-" + variant : "");
  toastEl.textContent = message;
  container.appendChild(toastEl);

  setTimeout(function () {
    if (container.contains(toastEl)) {
      container.innerHTML = "";
    }
  }, 5000);
}

// NFR-5: 1단계에서 남겨둔 저장 실패 훅(notifyStorageError)을 실제 토스트로 연결한다.
function showErrorToast(message) {
  showToast(message, "error");
}

/* ===== 데이터 백업(내보내기/가져오기) =====
 * localStorage는 기기·브라우저별로 완전히 분리되어 있어 자동 동기화가 안 되므로,
 * 사용자가 직접 JSON 파일로 내보내고 다른 기기/브라우저에서 가져올 수 있게 한다.
 */

function exportData() {
  var payload = {
    exportedAt: new Date().toISOString(),
    todos: loadTodos(),
    challenge: loadChallenge(),
  };

  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob);

  var link = document.createElement("a");
  link.href = url;
  link.download = "todoapp-backup-" + todayStr() + ".json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast("내보내기 완료: " + link.download, "success");
}

function isValidImportPayload(payload) {
  return (
    !!payload &&
    typeof payload === "object" &&
    Array.isArray(payload.todos) &&
    !!payload.challenge &&
    typeof payload.challenge === "object"
  );
}

function applyImportedData(payload) {
  saveTodos(payload.todos);

  // 백업 시점의 challenge에 없는 필드(예: 이전 버전에서 내보낸 startDate 누락)는 기본값으로 채운다.
  var mergedChallenge = Object.assign({}, getDefaultChallenge(), payload.challenge);
  saveChallenge(mergedChallenge);

  // 가져온 lastAchievedDate가 이 기기의 오늘 기준으로 이미 2일 이상 지났다면 currentStreak를 초기화한다.
  checkStreakOnLoad();

  challengeSettingsOpen = false;
  editingId = null;
  renderAll();

  showToast("가져오기 완료", "success");
}

function importDataFromFile(file) {
  var reader = new FileReader();

  reader.onload = function () {
    var payload;
    try {
      payload = JSON.parse(reader.result);
    } catch (e) {
      notifyStorageError("가져오기 실패: 올바른 백업 파일이 아닙니다.");
      return;
    }

    if (!isValidImportPayload(payload)) {
      notifyStorageError("가져오기 실패: 백업 파일 형식이 올바르지 않습니다.");
      return;
    }

    var confirmed = window.confirm("가져오기를 하면 이 기기에 저장된 할 일/챌린지 데이터를 덮어씁니다. 계속할까요?");
    if (!confirmed) return;

    applyImportedData(payload);
  };

  reader.onerror = function () {
    notifyStorageError("가져오기 실패: 파일을 읽을 수 없습니다.");
  };

  reader.readAsText(file);
}

function initBackupControls() {
  var exportBtn = document.getElementById("export-btn");
  var importBtn = document.getElementById("import-btn");
  var importInput = document.getElementById("import-file-input");

  exportBtn.addEventListener("click", exportData);

  importBtn.addEventListener("click", function () {
    importInput.click();
  });

  importInput.addEventListener("change", function () {
    var file = importInput.files && importInput.files[0];
    if (file) importDataFromFile(file);
    importInput.value = ""; // 같은 파일을 다시 선택해도 change 이벤트가 발생하도록 초기화
  });
}

function clearPendingDeleteToast() {
  if (pendingDeleteTimer) {
    clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = null;
  }
  pendingDelete = null;
  document.getElementById("toast-container").innerHTML = "";
}

function showDeleteToast(todo, index) {
  clearPendingDeleteToast();
  pendingDelete = { todo: todo, index: index };

  var toastEl = document.createElement("div");
  toastEl.className = "toast";

  var msg = document.createElement("span");
  msg.textContent = "삭제됨";

  var undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.id = "undo-delete-btn";
  undoBtn.textContent = "실행 취소";

  toastEl.appendChild(msg);
  toastEl.appendChild(undoBtn);

  var container = document.getElementById("toast-container");
  container.innerHTML = "";
  container.appendChild(toastEl);

  pendingDeleteTimer = setTimeout(function () {
    pendingDeleteTimer = null;
    pendingDelete = null;
    container.innerHTML = "";
  }, 5000);
}

function handleDeleteClick(id) {
  var todosBeforeDelete = loadTodos();
  var index = todosBeforeDelete.findIndex(function (t) {
    return t.id === id;
  });
  if (index === -1) return;

  var removed = deleteTodo(id);
  if (!removed) return;

  if (editingId === id) editingId = null;
  showDeleteToast(removed, index);
  renderAll();
}

function undoDelete() {
  if (!pendingDelete) return;
  var todo = pendingDelete.todo;
  var index = pendingDelete.index;
  clearPendingDeleteToast();
  restoreTodo(todo, index);
  renderAll();
}

// 목록 컨테이너에 이벤트를 위임해 붙인다 (렌더링마다 재등록되지 않도록 최초 1회만 호출).
function initTodoListEvents() {
  var listEl = document.getElementById("todo-list");

  listEl.addEventListener("click", function (e) {
    var li = e.target.closest(".todo-item");
    if (!li) return;
    var id = li.dataset.id;

    if (e.target.classList.contains("edit-btn")) {
      editingId = id;
      renderTodos();
    } else if (e.target.classList.contains("delete-btn")) {
      handleDeleteClick(id);
    } else if (e.target.classList.contains("save-btn")) {
      saveEdit(id, li.querySelector(".edit-text-input"), li.querySelector(".edit-category-select"));
    } else if (e.target.classList.contains("cancel-btn")) {
      editingId = null;
      renderTodos();
    }
  });

  listEl.addEventListener("change", function (e) {
    if (!e.target.classList.contains("todo-toggle")) return;
    var li = e.target.closest(".todo-item");
    if (!li) return;
    toggleDone(li.dataset.id);
    renderAll();
  });

  listEl.addEventListener("keydown", function (e) {
    var li = e.target.closest(".todo-item");
    if (!li || !li.classList.contains("editing")) return;

    if (e.key === "Enter") {
      e.preventDefault();
      saveEdit(li.dataset.id, li.querySelector(".edit-text-input"), li.querySelector(".edit-category-select"));
    } else if (e.key === "Escape") {
      editingId = null;
      renderTodos();
    }
  });

  document.getElementById("toast-container").addEventListener("click", function (e) {
    if (e.target.id === "undo-delete-btn") undoDelete();
  });
}

function initTodoForm() {
  var form = document.getElementById("todo-form");
  var textInput = document.getElementById("todo-input");
  var categorySelect = document.getElementById("category-select");

  populateCategorySelect(categorySelect, loadCategories(), loadLastCategory());

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var newTodo = addTodo(textInput.value, categorySelect.value);
    if (!newTodo) return; // 빈 문자열/공백만 입력한 경우 추가하지 않는다 (FR-1.2).

    saveLastCategory(categorySelect.value);
    textInput.value = "";
    textInput.focus();
    renderAll();
  });
}

/* ===== 카테고리 관리 UI ===== */

function renderCategoryChips() {
  var container = document.getElementById("category-chip-list");
  container.innerHTML = "";

  loadCategories().forEach(function (c) {
    var chip = document.createElement("span");
    chip.className = "category-chip";
    chip.style.backgroundColor = hexToRgba(c.color, 0.14);
    chip.style.color = c.color;
    chip.dataset.id = c.id;

    var label = document.createElement("span");
    label.textContent = c.label;
    chip.appendChild(label);

    if (!isBuiltInCategory(c.id)) {
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "category-chip-remove";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", c.label + " 삭제");
      chip.appendChild(removeBtn);
    }

    container.appendChild(chip);
  });
}

// 카테고리 추가/삭제로 목록이 바뀔 때, 이를 참조하는 화면 전체를 다시 그린다.
function refreshCategoryDependentUI() {
  populateCategorySelect(document.getElementById("category-select"), loadCategories(), loadLastCategory());
  renderFilterTabs();
  renderCategoryChips();
  renderAll();
}

function initCategoryManagement() {
  var form = document.getElementById("category-form");
  var nameInput = document.getElementById("category-name-input");
  var colorInput = document.getElementById("category-color-input");
  var chipList = document.getElementById("category-chip-list");

  colorInput.value = pickNextPaletteColor(loadCategories().length);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var created = addCategory(nameInput.value, colorInput.value);
    if (!created) {
      showToast("카테고리를 추가하지 못했습니다. 이름을 확인해 주세요(중복/빈 이름 불가).", "error");
      return;
    }
    nameInput.value = "";
    colorInput.value = pickNextPaletteColor(loadCategories().length);
    refreshCategoryDependentUI();
  });

  chipList.addEventListener("click", function (e) {
    if (!e.target.classList.contains("category-chip-remove")) return;
    var chip = e.target.closest(".category-chip");
    var id = chip.dataset.id;
    var category = loadCategories().find(function (c) {
      return c.id === id;
    });
    if (!category) return;

    var confirmed = window.confirm(
      "'" + category.label + "' 카테고리를 삭제할까요? 이 카테고리로 등록된 할 일은 '업무'로 이동합니다."
    );
    if (!confirmed) return;

    deleteCategory(id);
    if (currentFilter === id) currentFilter = "all";
    refreshCategoryDependentUI();
  });
}

/* ===== 프로필(여러 사용자) =====
 * 모든 데이터(할 일/챌린지/카테고리/마지막 카테고리)는 scopedKey()를 통해 프로필별로 분리 저장된다.
 * 프로필 목록 자체(todoapp.profiles)만 예외적으로 프로필과 무관하게 공용으로 저장된다.
 */

function loadProfiles() {
  try {
    var raw = localStorage.getItem(STORAGE_KEYS.PROFILES);
    var profiles = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(profiles)) profiles = [];

    // 프로필 개념 도입 전 데이터가 남아 있으면 "기본 프로필"로 자동 편입해 잃어버리지 않게 한다.
    var hasLegacyData = localStorage.getItem(STORAGE_KEYS.TODOS) !== null || localStorage.getItem(STORAGE_KEYS.CHALLENGE) !== null;
    var hasLegacyProfile = profiles.some(function (p) {
      return p.id === LEGACY_PROFILE_ID;
    });
    if (hasLegacyData && !hasLegacyProfile) {
      profiles.unshift({ id: LEGACY_PROFILE_ID, name: "기본 프로필", color: PALETTE_COLORS[0], photo: null });
      saveProfiles(profiles);
    }

    return profiles;
  } catch (e) {
    notifyStorageError("프로필 데이터를 불러오지 못했습니다.");
    return [];
  }
}

function saveProfiles(profiles) {
  try {
    localStorage.setItem(STORAGE_KEYS.PROFILES, JSON.stringify(profiles));
    return true;
  } catch (e) {
    notifyStorageError("저장에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.");
    return false;
  }
}

// 이름이 비어 있으면 추가하지 않고 null을 반환한다. photo는 data URL 문자열 또는 null.
function addProfile(name, color, photo) {
  var trimmed = (name || "").trim();
  if (!trimmed) return null;

  var profiles = loadProfiles();
  var newProfile = {
    id: generateId("profile-"),
    name: trimmed,
    color: color || pickNextPaletteColor(profiles.length),
    photo: photo || null,
  };
  profiles.push(newProfile);
  saveProfiles(profiles);
  return newProfile;
}

// 이름/색상/사진 중 바뀐 값만 changes에 담아 전달한다 (예: 사진을 새로 안 골랐으면 photo는 생략).
function updateProfile(id, changes) {
  var profiles = loadProfiles();
  var idx = profiles.findIndex(function (p) {
    return p.id === id;
  });
  if (idx === -1) return null;

  profiles[idx] = Object.assign({}, profiles[idx], changes);
  saveProfiles(profiles);
  return profiles[idx];
}

// 최소 1개의 프로필은 남겨둔다. 삭제 시 그 프로필의 할 일/챌린지/카테고리 데이터도 함께 지운다.
function deleteProfile(id) {
  var profiles = loadProfiles();
  if (profiles.length <= 1) return false;

  var remaining = profiles.filter(function (p) {
    return p.id !== id;
  });
  if (remaining.length === profiles.length) return false; // 존재하지 않는 id

  saveProfiles(remaining);

  var suffix = id === LEGACY_PROFILE_ID ? "" : "." + id;
  [STORAGE_KEYS.TODOS, STORAGE_KEYS.CHALLENGE, STORAGE_KEYS.LAST_CATEGORY, STORAGE_KEYS.CATEGORIES].forEach(function (base) {
    try {
      localStorage.removeItem(base + suffix);
    } catch (e) {
      // 정리 실패는 조용히 무시한다 (삭제 자체는 이미 반영됨).
    }
  });

  return true;
}

// 이미지 파일을 정사각형으로 잘라 최대 maxSize px로 축소한 JPEG data URL로 변환한다
// (localStorage 용량을 아끼기 위함). 실패하면 callback(null)을 호출한다.
function readImageAsResizedDataUrl(file, maxSize, callback) {
  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () {
      var side = Math.min(img.width, img.height);
      var sx = (img.width - side) / 2;
      var sy = (img.height - side) / 2;
      var size = Math.min(maxSize, side);

      var canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      callback(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = function () {
      callback(null);
    };
    img.src = reader.result;
  };
  reader.onerror = function () {
    callback(null);
  };
  reader.readAsDataURL(file);
}

// 관리 모드(프로필 삭제 가능 상태)인지 여부. 메모리에만 유지한다.
var profileManageMode = false;

function createProfileTile(profile) {
  var tile = document.createElement("button");
  tile.type = "button";
  tile.className = "profile-tile";
  tile.dataset.id = profile.id;

  var avatar = document.createElement("div");
  avatar.className = "profile-avatar";
  avatar.style.borderColor = profile.color; // 사진이든 이니셜이든 프로필 색상이 테두리로 감싼다.
  if (profile.photo) {
    avatar.style.backgroundImage = "url(" + profile.photo + ")";
  } else {
    avatar.style.backgroundColor = profile.color;
    var initial = document.createElement("span");
    initial.className = "profile-avatar-initial";
    initial.textContent = profile.name.charAt(0);
    avatar.appendChild(initial);
  }

  if (profileManageMode) {
    var removeBtn = document.createElement("span");
    removeBtn.className = "profile-remove-btn";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("role", "button");
    removeBtn.setAttribute("aria-label", profile.name + " 삭제");
    avatar.appendChild(removeBtn);

    var editHint = document.createElement("span");
    editHint.className = "profile-edit-hint";
    editHint.textContent = "✎";
    avatar.appendChild(editHint);
  }

  var name = document.createElement("span");
  name.className = "profile-name";
  name.textContent = profile.name;

  tile.appendChild(avatar);
  tile.appendChild(name);
  return tile;
}

function createAddProfileTile() {
  var tile = document.createElement("button");
  tile.type = "button";
  tile.id = "add-profile-tile";
  tile.className = "profile-tile profile-tile-add";

  var avatar = document.createElement("div");
  avatar.className = "profile-avatar profile-avatar-add";
  avatar.textContent = "+";

  var name = document.createElement("span");
  name.className = "profile-name";
  name.textContent = "프로필 추가";

  tile.appendChild(avatar);
  tile.appendChild(name);
  return tile;
}

function renderProfileGrid() {
  var grid = document.getElementById("profile-grid");
  grid.innerHTML = "";

  loadProfiles().forEach(function (p) {
    grid.appendChild(createProfileTile(p));
  });
  grid.appendChild(createAddProfileTile());

  document.getElementById("profile-manage-btn").textContent = profileManageMode ? "완료" : "프로필 관리";
}

// 프로필을 선택해 메인 앱으로 들어간다. initMainApp()은 여기서 딱 한 번만 호출된다
// (프로필 전환은 location.reload()로 처리하므로 리스너가 중복 등록될 일이 없다).
function enterApp(profileId) {
  currentProfileId = profileId;
  document.getElementById("profile-picker-screen").hidden = true;
  document.getElementById("app-root").hidden = false;
  initMainApp();
}

// 수정 중인 프로필 id. null이면 "새 프로필 추가" 모드, 값이 있으면 그 프로필을 수정하는 중.
var editingProfileId = null;

function setProfileFormPreview(profile) {
  var preview = document.getElementById("profile-form-preview");
  if (!profile) {
    preview.hidden = true;
    preview.style.backgroundImage = "";
    preview.textContent = "";
    return;
  }
  preview.hidden = false;
  preview.style.borderColor = profile.color;
  if (profile.photo) {
    preview.style.backgroundImage = "url(" + profile.photo + ")";
    preview.textContent = "";
  } else {
    preview.style.backgroundImage = "";
    preview.style.backgroundColor = profile.color;
    preview.textContent = profile.name.charAt(0);
  }
}

function initProfilePicker() {
  var grid = document.getElementById("profile-grid");
  var manageBtn = document.getElementById("profile-manage-btn");
  var addForm = document.getElementById("add-profile-form");
  var nameInput = document.getElementById("profile-name-input");
  var photoInput = document.getElementById("profile-photo-input");
  var colorInput = document.getElementById("profile-color-input");
  var submitBtn = document.getElementById("profile-form-submit-btn");
  var cancelBtn = document.getElementById("add-profile-cancel-btn");

  colorInput.value = pickNextPaletteColor(loadProfiles().length);

  function openAddForm() {
    editingProfileId = null;
    nameInput.value = "";
    photoInput.value = "";
    colorInput.value = pickNextPaletteColor(loadProfiles().length);
    submitBtn.textContent = "추가";
    setProfileFormPreview(null);
    addForm.hidden = false;
    nameInput.focus();
  }

  function openEditForm(profile) {
    editingProfileId = profile.id;
    nameInput.value = profile.name;
    photoInput.value = "";
    colorInput.value = profile.color;
    submitBtn.textContent = "저장";
    setProfileFormPreview(profile);
    addForm.hidden = false;
    nameInput.focus();
  }

  grid.addEventListener("click", function (e) {
    if (e.target.classList.contains("profile-remove-btn")) {
      var removeTile = e.target.closest(".profile-tile");
      var removeId = removeTile.dataset.id;
      var profile = loadProfiles().find(function (p) {
        return p.id === removeId;
      });
      if (!profile) return;

      var confirmed = window.confirm(
        "'" + profile.name + "' 프로필을 삭제할까요? 이 프로필의 할 일과 챌린지 기록도 함께 삭제됩니다."
      );
      if (!confirmed) return;

      if (!deleteProfile(removeId)) {
        showToast("최소 1개의 프로필은 남아 있어야 합니다.", "error");
      }
      if (editingProfileId === removeId) {
        editingProfileId = null;
        addForm.hidden = true;
      }
      renderProfileGrid();
      return;
    }

    if (e.target.closest("#add-profile-tile")) {
      openAddForm();
      return;
    }

    var tile = e.target.closest(".profile-tile");
    if (!tile || tile.id === "add-profile-tile") return;

    if (profileManageMode) {
      // 관리 모드에서는 프로필 선택 대신 이름/사진 수정 폼을 연다.
      var editTarget = loadProfiles().find(function (p) {
        return p.id === tile.dataset.id;
      });
      if (editTarget) openEditForm(editTarget);
      return;
    }

    enterApp(tile.dataset.id);
  });

  manageBtn.addEventListener("click", function () {
    profileManageMode = !profileManageMode;
    editingProfileId = null;
    addForm.hidden = true;
    renderProfileGrid();
  });

  cancelBtn.addEventListener("click", function () {
    editingProfileId = null;
    addForm.hidden = true;
  });

  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var file = photoInput.files && photoInput.files[0];

    function finish(photoDataUrl) {
      if (editingProfileId) {
        var changes = { name: nameInput.value.trim(), color: colorInput.value };
        if (!changes.name) {
          showToast("이름을 입력해 주세요.", "error");
          return;
        }
        if (photoDataUrl) changes.photo = photoDataUrl; // 새 사진을 고르지 않았으면 기존 사진 유지
        updateProfile(editingProfileId, changes);
      } else {
        var created = addProfile(nameInput.value, colorInput.value, photoDataUrl);
        if (!created) {
          showToast("이름을 입력해 주세요.", "error");
          return;
        }
      }

      editingProfileId = null;
      nameInput.value = "";
      photoInput.value = "";
      colorInput.value = pickNextPaletteColor(loadProfiles().length);
      addForm.hidden = true;
      renderProfileGrid();
    }

    if (file) {
      readImageAsResizedDataUrl(file, 200, finish);
    } else {
      finish(null);
    }
  });

  renderProfileGrid();
}

/* ===== BGM 플레이어 =====
 * 외부 음원 파일을 넣을 수 없는 오프라인(file://) 환경이라, Web Audio API로 저작권 문제 없는
 * 밝고 진취적인 리듬의 아르페지오를 코드로 직접 합성해 재생한다. 프로필 진입(클릭 = 사용자
 * 제스처) 직후 자동으로 시작하므로 브라우저 자동재생 정책에 걸리지 않는다.
 */

var BGM_BPM = 128;
var BGM_STEP_SECONDS = 60 / BGM_BPM / 2; // 8분음표 하나의 길이(초)
var BGM_STEPS_PER_CHORD = 8; // 코드 하나당 8분음표 8개 = 한 마디

// 밝은 장조 진행 (C - G - Am - F): 각 화음은 [근음, 3음, 5음] 순서.
var BGM_PROGRESSION = [
  [261.63, 329.63, 392.0], // C
  [196.0, 246.94, 293.66], // G
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
];
var BGM_ARPEGGIO_STEPS = [0, 1, 2, 1, 2, 1, 0, 2]; // 근음-3음-5음을 오가는 8분음표 패턴

var bgmAudioCtx = null;
var bgmMasterGain = null;
var bgmFilter = null;
var bgmStepIndex = 0;
var bgmChordPos = 0;
var bgmScheduleTimer = null;
var bgmPlaying = false;

function ensureBgmGraph() {
  if (bgmAudioCtx) return;
  var AudioContextClass = window.AudioContext || window.webkitAudioContext;
  bgmAudioCtx = new AudioContextClass();

  bgmMasterGain = bgmAudioCtx.createGain();
  bgmMasterGain.gain.value = Number(document.getElementById("bgm-volume").value) / 100;

  bgmFilter = bgmAudioCtx.createBiquadFilter();
  bgmFilter.type = "lowpass";
  bgmFilter.frequency.value = 4000; // 어두운 패드가 아니라 밝은 음색이 살도록 컷오프를 높게 둔다.

  bgmFilter.connect(bgmMasterGain);
  bgmMasterGain.connect(bgmAudioCtx.destination);
}

// 짧게 톡 튀는(pluck) 아르페지오 음 하나를 재생한다.
function playBgmPluck(freq, gainLevel) {
  var now = bgmAudioCtx.currentTime;
  var osc = bgmAudioCtx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;

  var noteGain = bgmAudioCtx.createGain();
  noteGain.gain.setValueAtTime(0, now);
  noteGain.gain.linearRampToValueAtTime(gainLevel, now + 0.008);
  noteGain.gain.exponentialRampToValueAtTime(0.001, now + BGM_STEP_SECONDS * 0.95);

  osc.connect(noteGain);
  noteGain.connect(bgmFilter);
  osc.start(now);
  osc.stop(now + BGM_STEP_SECONDS);
}

function scheduleNextBgmStep() {
  if (!bgmPlaying) return;

  var chord = BGM_PROGRESSION[bgmChordPos % BGM_PROGRESSION.length];
  var noteIndexInChord = BGM_ARPEGGIO_STEPS[bgmStepIndex % BGM_ARPEGGIO_STEPS.length];
  playBgmPluck(chord[noteIndexInChord], 0.25);

  // 마디 첫박에는 한 옥타브 아래 근음을 살짝 더 크게 얹어 리듬의 중심을 잡는다.
  if (bgmStepIndex % BGM_STEPS_PER_CHORD === 0) {
    playBgmPluck(chord[0] / 2, 0.3);
  }

  bgmStepIndex++;
  if (bgmStepIndex % BGM_STEPS_PER_CHORD === 0) {
    bgmChordPos++;
  }
  bgmScheduleTimer = setTimeout(scheduleNextBgmStep, BGM_STEP_SECONDS * 1000);
}

function startBgm() {
  ensureBgmGraph();
  if (bgmAudioCtx.state === "suspended") bgmAudioCtx.resume();
  if (bgmPlaying) return;
  bgmPlaying = true;
  scheduleNextBgmStep();
}

function stopBgm() {
  bgmPlaying = false;
  if (bgmScheduleTimer) {
    clearTimeout(bgmScheduleTimer);
    bgmScheduleTimer = null;
  }
  if (bgmAudioCtx) bgmAudioCtx.suspend();
}

function initBgmPlayer() {
  var toggleBtn = document.getElementById("bgm-toggle-btn");
  var volumeInput = document.getElementById("bgm-volume");

  toggleBtn.addEventListener("click", function () {
    if (bgmPlaying) {
      stopBgm();
      toggleBtn.textContent = "▶";
      toggleBtn.setAttribute("aria-label", "배경음악 재생");
    } else {
      startBgm();
      toggleBtn.textContent = "⏸";
      toggleBtn.setAttribute("aria-label", "배경음악 정지");
    }
  });

  volumeInput.addEventListener("input", function () {
    if (bgmMasterGain) {
      bgmMasterGain.gain.value = Number(volumeInput.value) / 100;
    }
  });

  // 프로필 선택(클릭)이라는 사용자 제스처 직후 호출되므로 자동재생 정책에 걸리지 않는다.
  startBgm();
  toggleBtn.textContent = "⏸";
  toggleBtn.setAttribute("aria-label", "배경음악 정지");
}

/* ===== 날짜/시간/날씨 위젯 =====
 * 날짜/시간은 로컬 시계로 표시하고, 날씨는 위치 권한이 있고 인터넷이 연결돼 있을 때만
 * Open-Meteo(무료, API 키 불필요, CORS 허용)로 조회한다. 실패해도 조용히 비워둔다 —
 * 이 앱은 오프라인(file://)에서도 동작해야 하므로 날씨는 있으면 좋은 부가 정보일 뿐이다.
 */

var WEEKDAY_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function formatDateTimeLabel(date) {
  var year = date.getFullYear();
  var month = String(date.getMonth() + 1).padStart(2, "0");
  var day = String(date.getDate()).padStart(2, "0");
  var weekday = WEEKDAY_LABELS_KO[date.getDay()];
  var hours24 = date.getHours();
  var ampm = hours24 < 12 ? "오전" : "오후";
  var hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  var minutes = String(date.getMinutes()).padStart(2, "0");
  return year + "." + month + "." + day + "(" + weekday + ") " + ampm + " " + hours12 + ":" + minutes;
}

function updateDateTimeText() {
  document.getElementById("datetime-text").textContent = formatDateTimeLabel(new Date());
}

var WEATHER_CODE_LABELS = {
  0: "☀️ 맑음",
  1: "🌤️ 대체로 맑음",
  2: "⛅ 약간 흐림",
  3: "☁️ 흐림",
  45: "🌫️ 안개",
  48: "🌫️ 안개",
  51: "🌦️ 이슬비",
  53: "🌦️ 이슬비",
  55: "🌦️ 이슬비",
  61: "🌧️ 비",
  63: "🌧️ 비",
  65: "🌧️ 강한 비",
  71: "🌨️ 눈",
  73: "🌨️ 눈",
  75: "🌨️ 강한 눈",
  80: "🌦️ 소나기",
  81: "🌦️ 소나기",
  82: "⛈️ 강한 소나기",
  95: "⛈️ 뇌우",
  96: "⛈️ 뇌우",
  99: "⛈️ 강한 뇌우",
};

function describeWeatherCode(code) {
  return WEATHER_CODE_LABELS[code] || "🌡️";
}

// 위치 권한 요청은 여기서만 발생한다 — 사용자가 버튼을 눌렀을 때만 호출되고,
// 페이지를 열거나 새로고침할 때 자동으로는 절대 호출하지 않는다 (file://에서는 권한 허용이
// 안정적으로 기억되지 않아 매번 새로고침될 때마다 프롬프트가 뜨는 문제가 있었다).
var weatherAutoRefreshTimer = null;

function fetchWeather() {
  var weatherBtn = document.getElementById("weather-text");
  if (!navigator.geolocation) return;

  weatherBtn.textContent = "…";

  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var url =
        "https://api.open-meteo.com/v1/forecast?latitude=" +
        pos.coords.latitude +
        "&longitude=" +
        pos.coords.longitude +
        "&current_weather=true";

      fetch(url)
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.current_weather) {
            weatherBtn.textContent = "🌤️ 날씨 보기";
            return;
          }
          var cw = data.current_weather;
          weatherBtn.textContent = describeWeatherCode(cw.weathercode) + " " + Math.round(cw.temperature) + "°C";

          // 권한을 이미 받은 뒤이므로, 이번 페이지가 열려 있는 동안에는 15분마다 조용히 갱신한다.
          if (!weatherAutoRefreshTimer) {
            weatherAutoRefreshTimer = setInterval(fetchWeather, 15 * 60 * 1000);
          }
        })
        .catch(function () {
          // 네트워크 오류(오프라인 등) 시 다시 눌러볼 수 있게 원래 문구로 되돌린다.
          weatherBtn.textContent = "🌤️ 날씨 보기";
        });
    },
    function () {
      // 위치 권한 거부/실패 시에도 다시 눌러볼 수 있게 원래 문구로 되돌린다.
      weatherBtn.textContent = "🌤️ 날씨 보기";
    },
    { timeout: 8000 }
  );
}

function initDateTimeWeather() {
  updateDateTimeText();
  setInterval(updateDateTimeText, 30000); // 분 단위로 보이므로 30초 주기면 충분하다.

  var weatherBtn = document.getElementById("weather-text");
  weatherBtn.textContent = "🌤️ 날씨 보기";
  weatherBtn.addEventListener("click", fetchWeather);
}

/* ===== 초기화 ===== */

// 메인 앱 초기화. 프로필을 선택해 enterApp()이 호출될 때 딱 한 번만 실행된다.
function initMainApp() {
  loadChallenge();
  checkStreakOnLoad(); // 프로필 진입 시 1회만 호출 (FR-5.4)
  loadCategories(); // 이 프로필에서 처음 진입 시 기본 카테고리 3종을 저장해 둔다.
  initTodoForm();
  initTodoListEvents();
  initFilterTabs();
  renderFilterTabs();
  initChallengeEvents();
  initSettingsActions();
  initCategoryManagement();
  renderCategoryChips();
  initBackupControls();
  initBgmPlayer();
  initDateTimeWeather();

  document.getElementById("switch-profile-btn").addEventListener("click", function () {
    location.reload(); // currentProfileId는 메모리에만 있으므로 새로고침하면 프로필 선택 화면으로 돌아간다.
  });

  renderAll();
}

setStorageErrorHandler(showErrorToast);
initProfilePicker();
