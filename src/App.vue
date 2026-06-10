<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';

type Screen = 'setup' | 'game' | 'result' | 'history';

interface Settings {
  teamCount: number;
  playersPerTeam: number;
  deckCount: number;
  threshold: number;
  liteFx: boolean;
  teamNames: string[];
}

interface Team {
  id: number;
  name: string;
  score: number;
}

interface ActionEntry {
  teamId: number;
  delta: number;
  previousScore: number;
  nextScore: number;
}

interface ActionBatch {
  entries: ActionEntry[];
  sweepTeamId?: number;
  sweepWasNew?: boolean;
}

interface RoundRecord {
  id: number;
  endedAt: number;
  winnerId: number;
  bigSweep: boolean;
  sweepTeamIds: number[];
  scores: { teamId: number; name: string; score: number }[];
}

const STORAGE_KEY = 'maduiScore.v1.4';

const defaultSettings = (): Settings => ({
  teamCount: 2,
  playersPerTeam: 2,
  deckCount: 3,
  threshold: 1000,
  liteFx: true,
  teamNames: ['红队', '蓝队', '绿队', '黄队']
});

const state = reactive<{
  screen: Screen;
  settings: Settings;
  teams: Team[];
  actions: ActionBatch[];
  rounds: RoundRecord[];
  lastSweep: { winnerName: string } | null;
  currentSweepTeamIds: number[];
}>({
  screen: 'setup',
  settings: defaultSettings(),
  teams: [],
  actions: [],
  rounds: [],
  lastSweep: null,
  currentSweepTeamIds: []
});

const customInputs = reactive<Record<number, string>>({});
const sweepShown = ref(false);
const sweepKey = ref(0);
let sweepTimer: number | undefined;
const showUndoConfirm = ref(false);
const showResetConfirm = ref(false);
const toastMsg = ref('');
let toastTimer: number | undefined;

const teamColorClass = (id: number) => `t-${id % 4}`;

const totalPoints = computed(() => state.settings.deckCount * 100);
const inputMax = computed(() => totalPoints.value + state.settings.playersPerTeam * 20);
const inputMin = computed(() => -(state.settings.playersPerTeam * 20));

const isValidDelta = (value: number) =>
  Number.isInteger(value) && value % 5 === 0 &&
  value >= inputMin.value && value <= inputMax.value;

const showToast = (msg: string) => {
  toastMsg.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastMsg.value = ''; }, 1800);
};

const vibrate = (ms: number) => {
  if (navigator.vibrate) {
    try { navigator.vibrate(ms); } catch {}
  }
};

const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      settings: state.settings,
      teams: state.teams,
      actions: state.actions,
      rounds: state.rounds,
      currentSweepTeamIds: state.currentSweepTeamIds,
      screen: state.screen
    }));
  } catch {}
};

const loadPersisted = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.settings) state.settings = { ...defaultSettings(), ...parsed.settings };
    if (Array.isArray(parsed.teams)) state.teams = parsed.teams;
    if (Array.isArray(parsed.actions)) state.actions = parsed.actions;
    if (Array.isArray(parsed.rounds)) state.rounds = parsed.rounds;
    if (Array.isArray(parsed.currentSweepTeamIds)) state.currentSweepTeamIds = parsed.currentSweepTeamIds;
    if (parsed.screen === 'game' && state.teams.length > 0) {
      state.screen = 'game';
    }
  } catch {}
};

watch(() => state, persist, { deep: true });

const teamCountOptions = [2, 3, 4];
const deckOptions = [1, 2, 3, 4, 5];

const setTeamCount = (n: number) => {
  state.settings.teamCount = n;
  while (state.settings.teamNames.length < n) {
    state.settings.teamNames.push(['红队','蓝队','绿队','黄队'][state.settings.teamNames.length] || `队伍${state.settings.teamNames.length + 1}`);
  }
};

const startGame = () => {
  const names = state.settings.teamNames.slice(0, state.settings.teamCount);
  state.teams = names.map((name, i) => ({ id: i, name: name.trim() || `队伍${i + 1}`, score: 0 }));
  state.actions = [];
  state.lastSweep = null;
  state.currentSweepTeamIds = [];
  Object.keys(customInputs).forEach(k => delete customInputs[Number(k)]);
  state.teams.forEach(t => { customInputs[t.id] = ''; });
  state.screen = 'game';
};

const pendingEntries = computed(() => {
  return state.teams.map(team => {
    const rawVal = customInputs[team.id];
    const raw = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
    const num = raw === '' ? NaN : Number(raw);
    return { team, raw, value: num };
  });
});

const applyScore = (team: Team, delta: number): ActionEntry | null => {
  if (delta === 0) return null;
  const prev = team.score;
  const next = prev + delta;
  team.score = next;
  return { teamId: team.id, delta, previousScore: prev, nextScore: next };
};

const checkBigSweep = (deltas: { teamId: number; delta: number }[]): Team | null => {
  if (state.settings.teamCount !== 2) return null;
  const [a, b] = state.teams;
  if (!a || !b) return null;
  const total = totalPoints.value;
  const dA = deltas.find(d => d.teamId === a.id)?.delta ?? 0;
  const dB = deltas.find(d => d.teamId === b.id)?.delta ?? 0;
  // 大剔：本轮一方拿到全部牌面分 + 对方倒扣分（>= total），另一方为负分
  if (dA >= total && dB < 0) return a;
  if (dB >= total && dA < 0) return b;
  return null;
};

const triggerSweep = (winner: Team) => {
  state.lastSweep = { winnerName: winner.name };
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }
  // 强制重置以便重新播放动画
  sweepShown.value = false;
  sweepKey.value++;
  nextTick(() => {
    sweepShown.value = true;
    vibrate(50);
    sweepTimer = window.setTimeout(() => {
      sweepShown.value = false;
      sweepTimer = undefined;
    }, 2200);
  });
};

const finalizeRound = (winnerId: number, bigSweep: boolean) => {
  const winner = state.teams.find(t => t.id === winnerId);
  if (!winner) return;
  const sweepIds = [...state.currentSweepTeamIds];
  const record: RoundRecord = {
    id: Date.now(),
    endedAt: Date.now(),
    winnerId,
    bigSweep: bigSweep || sweepIds.length > 0,
    sweepTeamIds: sweepIds,
    scores: state.teams.map(t => ({ teamId: t.id, name: t.name, score: t.score }))
  };
  state.rounds.unshift(record);
  // 结算后重置当前对局状态
  state.teams.forEach(t => { t.score = 0; });
  state.actions = [];
  state.currentSweepTeamIds = [];
  state.teams.forEach(t => { customInputs[t.id] = ''; });
  if (record.bigSweep) state.lastSweep = { winnerName: winner.name };
  state.screen = 'result';
};

const submitAllScores = () => {
  const entries = pendingEntries.value.map(e => ({
    ...e,
    value: e.raw === '' ? 0 : e.value
  }));
  for (const e of entries) {
    if (!Number.isFinite(e.value) || !isValidDelta(e.value)) {
      showToast(`分数必须是5的倍数，且在 ${inputMin.value} ~ ${inputMax.value}`);
      vibrate(20);
      return;
    }
  }
  if (entries.every(e => e.value === 0)) {
    showToast('请至少为一个队伍录入分数');
    vibrate(20);
    return;
  }
  const sumOfDeltas = entries.reduce((acc, e) => acc + e.value, 0);
  if (sumOfDeltas !== totalPoints.value) {
    showToast('当前分数有误请重新确认');
    vibrate(20);
    return;
  }

  const entryList: ActionEntry[] = [];
  for (const { team, value } of entries) {
    const entry = applyScore(team, value);
    if (entry) entryList.push(entry);
    customInputs[team.id] = '';
  }

  const sweepWinner = checkBigSweep(entries.map(e => ({ teamId: e.team.id, delta: e.value })));
  let sweepWasNew = false;
  if (sweepWinner) {
    sweepWasNew = !state.currentSweepTeamIds.includes(sweepWinner.id);
    if (sweepWasNew) state.currentSweepTeamIds.push(sweepWinner.id);
    triggerSweep(sweepWinner);
  }

  if (entryList.length || sweepWinner) {
    state.actions.push({
      entries: entryList,
      sweepTeamId: sweepWinner?.id,
      sweepWasNew
    });
  }

  const overflowed = state.teams.find(t => t.score >= state.settings.threshold);
  if (overflowed) {
    finalizeRound(overflowed.id, false);
  }
};

const requestUndo = () => {
  if (state.actions.length === 0) {
    showToast('没有可撤销的操作');
    return;
  }
  showUndoConfirm.value = true;
};

const confirmUndo = () => {
  const batch = state.actions.pop();
  if (batch) {
    for (const entry of batch.entries) {
      const team = state.teams.find(t => t.id === entry.teamId);
      if (team) team.score = entry.previousScore;
    }
    if (batch.sweepWasNew && batch.sweepTeamId !== undefined) {
      const idx = state.currentSweepTeamIds.indexOf(batch.sweepTeamId);
      if (idx >= 0) state.currentSweepTeamIds.splice(idx, 1);
    }
  }
  showUndoConfirm.value = false;
};

const requestReset = () => { showResetConfirm.value = true; };

const confirmReset = () => {
  state.teams.forEach(t => { t.score = 0; });
  state.actions = [];
  state.currentSweepTeamIds = [];
  state.teams.forEach(t => { customInputs[t.id] = ''; });
  showResetConfirm.value = false;
};

const playAgain = () => {
  state.teams.forEach(t => { t.score = 0; });
  state.actions = [];
  state.lastSweep = null;
  state.currentSweepTeamIds = [];
  state.teams.forEach(t => { customInputs[t.id] = ''; });
  state.screen = 'game';
};

const showBackConfirm = ref(false);

const requestBackToSetup = () => {
  // 如果当前没有得分变动，直接返回；否则弹确认
  const hasProgress = state.teams.some(t => t.score !== 0) || state.actions.length > 0;
  if (hasProgress) {
    showBackConfirm.value = true;
  } else {
    goSetup();
  }
};

const confirmBackToSetup = () => {
  state.teams.forEach(t => { t.score = 0; });
  state.actions = [];
  state.currentSweepTeamIds = [];
  state.teams.forEach(t => { customInputs[t.id] = ''; });
  showBackConfirm.value = false;
  goSetup();
};

const goSetup = () => {
  state.screen = 'setup';
  state.lastSweep = null;
};

const goHistory = () => { state.screen = 'history'; };

const replaySweep = (round: RoundRecord) => {
  const winner = round.scores.find(s => s.teamId === round.winnerId);
  if (!winner) return;
  state.lastSweep = { winnerName: winner.name };
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }
  sweepShown.value = false;
  sweepKey.value++;
  nextTick(() => {
    sweepShown.value = true;
    sweepTimer = window.setTimeout(() => {
      sweepShown.value = false;
      sweepTimer = undefined;
    }, 2400);
  });
};

const winsByTeam = computed(() => {
  const map = new Map<number, { name: string; wins: number }>();
  for (const r of state.rounds) {
    const winner = r.scores.find(s => s.teamId === r.winnerId);
    if (!winner) continue;
    const cur = map.get(r.winnerId);
    if (cur) cur.wins += 1;
    else map.set(r.winnerId, { name: winner.name, wins: 1 });
  }
  return Array.from(map.values()).sort((a, b) => b.wins - a.wins);
});

const dangerTeam = computed(() => {
  const close = state.teams.filter(t => t.score >= state.settings.threshold * 0.9);
  if (close.length === 0) return null;
  return close.sort((a, b) => b.score - a.score)[0];
});

const winnerOfCurrent = computed(() => {
  if (state.rounds.length === 0) return null;
  const r = state.rounds[0];
  return r.scores.find(s => s.teamId === r.winnerId) || null;
});

const confettiPieces = computed(() => {
  const pieces: { dx: number; dy: number; rot: number; color: string; delay: number }[] = [];
  const colors = ['#FFD466', '#FF85B2', '#8C7BFF', '#6FB7FF', '#5BD6A6', '#FFB48A'];
  const count = state.settings.liteFx ? 28 : 56;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const dist = 240 + Math.random() * 180;
    pieces.push({
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      rot: Math.random() * 720 - 360,
      color: colors[i % colors.length],
      delay: Math.random() * 0.2
    });
  }
  return pieces;
});

const resultConfetti = computed(() => {
  const pieces: { left: number; drift: number; dur: number; delay: number; color: string }[] = [];
  const colors = ['#FFD466', '#FF85B2', '#8C7BFF', '#6FB7FF', '#5BD6A6', '#FFB48A', '#ffffff'];
  const count = state.settings.liteFx ? 24 : 48;
  for (let i = 0; i < count; i++) {
    pieces.push({
      left: Math.random() * 100,
      drift: (Math.random() - 0.5) * 220,
      dur: 3 + Math.random() * 3,
      delay: Math.random() * 4,
      color: colors[i % colors.length]
    });
  }
  return pieces;
});

onMounted(() => {
  loadPersisted();
});

const formatTime = (ts: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const TEAM_LETTERS = ['A', 'B', 'C', 'D'];

const liveSum = computed(() => pendingEntries.value.reduce((acc, e) => acc + (Number.isFinite(e.value) ? e.value : 0), 0));
</script>

<template>
  <div class="app">
    <!-- ============ SETUP ============ -->
    <template v-if="state.screen === 'setup'">
      <div class="hero">
        <span class="hero-version">v1.3</span>
        <div class="hero-inner">
          <div class="hero-emblem">
            <span class="ring-outer"></span>
            <span class="ring-inner"><span class="suit">♠</span></span>
          </div>
          <div class="hero-title">马队积分</div>
          <div class="hero-sub">MA DUI · SCORE</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">对局设置</div>
        <div class="row">
          <span class="label">队伍数量</span>
          <div class="ctrl">
            <div class="seg">
              <button
                v-for="n in teamCountOptions"
                :key="n"
                :class="{ on: state.settings.teamCount === n }"
                @click="setTeamCount(n)"
              >{{ n }}队</button>
            </div>
          </div>
        </div>
        <div class="row">
          <span class="label">每队人数</span>
          <div class="ctrl">
            <input class="input-num" type="number" min="2" max="8" v-model.number="state.settings.playersPerTeam" />
          </div>
        </div>
        <div class="row">
          <span class="label">扑克牌副数</span>
          <div class="ctrl">
            <div class="seg">
              <button
                v-for="d in deckOptions"
                :key="d"
                :class="{ on: state.settings.deckCount === d }"
                @click="state.settings.deckCount = d"
              >{{ d }}副</button>
            </div>
          </div>
        </div>
        <div class="row">
          <span class="label">出锅上限</span>
          <div class="ctrl">
            <input class="input-num" type="number" min="100" step="5" v-model.number="state.settings.threshold" />
          </div>
        </div>
        <div class="row">
          <span class="label">精简庆祝动效</span>
          <label class="switch">
            <input type="checkbox" v-model="state.settings.liteFx" />
            <span class="track"></span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-title">队伍名称</div>
        <div class="name-list">
          <div
            v-for="i in state.settings.teamCount"
            :key="i"
            class="name-row"
          >
            <span class="team-chip" :class="`t-${(i-1)%4}`">{{ TEAM_LETTERS[(i-1)%4] }}</span>
            <input
              class="input-name"
              type="text"
              maxlength="8"
              :placeholder="`队伍${i}`"
              v-model="state.settings.teamNames[i-1]"
            />
          </div>
        </div>
      </div>

      <button class="btn btn-block btn-primary" @click="startGame">开 始 游 戏</button>

      <div v-if="state.rounds.length > 0" style="margin-top: 16px; text-align: center;">
        <button class="btn btn-ghost" @click="goHistory">查看战绩 · {{ state.rounds.length }}</button>
      </div>
    </template>

    <!-- ============ GAME ============ -->
    <template v-else-if="state.screen === 'game'">
      <div class="page-head">
        <span class="emblem-sm"></span>
        <div class="titles">
          <span class="zh">计分中</span>
          <span class="en">{{ state.settings.deckCount }}副 · {{ state.settings.teamCount }}队 · 上限 {{ state.settings.threshold }}</span>
        </div>
        <div class="head-actions">
          <button class="icon-btn" @click="requestBackToSetup">←</button>
          <button class="icon-btn" @click="goHistory">≡</button>
        </div>
      </div>

      <div class="scoreboard" :class="state.settings.teamCount === 3 ? 'cols-3' : (state.settings.teamCount === 1 ? 'cols-1' : '')">
        <div
          v-for="team in state.teams"
          :key="team.id"
          class="score-card"
          :class="[`t-${team.id % 4}`, { danger: dangerTeam && dangerTeam.id === team.id }]"
        >
          <div class="head"><span class="dot"></span>{{ team.name }}</div>
          <div class="value" :class="{ neg: team.score < 0 }">{{ team.score }}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">本轮录入 · 总和需 = <span class="target-pill">{{ totalPoints }}</span></div>
        <div class="input-list">
          <div
            v-for="team in state.teams"
            :key="team.id"
            class="input-item"
          >
            <span class="team-chip" :class="`t-${team.id % 4}`">{{ TEAM_LETTERS[team.id % 4] }}</span>
            <input
              class="input-delta"
              type="number"
              inputmode="numeric"
              step="5"
              placeholder="0"
              v-model="customInputs[team.id]"
            />
          </div>
        </div>

        <div class="sum-bar">
          <span>当前合计</span>
          <span>
            <span class="num" :class="{ match: liveSum === totalPoints, miss: liveSum !== 0 && liveSum !== totalPoints }">{{ liveSum }}</span>
            <span class="target">/ {{ totalPoints }}</span>
          </span>
        </div>

        <div class="actions-row">
          <button class="btn fixed" @click="requestUndo">撤销</button>
          <button class="btn btn-primary" @click="submitAllScores">确 认</button>
        </div>
      </div>

      <div style="text-align: center;">
        <button class="btn btn-ghost" @click="requestReset">清空当局</button>
      </div>
    </template>

    <!-- ============ RESULT ============ -->
    <template v-else-if="state.screen === 'result'">
      <div class="page-head">
        <span class="emblem-sm"></span>
        <div class="titles">
          <span class="zh">本局结束</span>
          <span class="en">ROUND END</span>
        </div>
      </div>

      <div class="result-hero">
        <div class="result-confetti">
          <span
            v-for="(p, i) in resultConfetti"
            :key="i"
            class="piece"
            :style="{
              left: p.left + '%',
              background: p.color,
              ['--drift' as any]: p.drift + 'px',
              ['--dur' as any]: p.dur + 's',
              ['--delay' as any]: p.delay + 's'
            }"
          ></span>
        </div>

        <div class="crown">👑</div>
        <div class="badge">本 局 获 胜</div>
        <div class="winner-wrap">
          <div class="winner">
            {{ winnerOfCurrent ? winnerOfCurrent.name : '—' }}
          </div>
          <span class="winner-shine"></span>
        </div>
        <div v-if="state.rounds[0]?.bigSweep" style="position: relative; z-index: 2; margin-top: 10px;">
          <span class="sweep-tag">大剔 · 全胜</span>
        </div>
        <div class="winner-score">
          得分 <span class="num">{{ winnerOfCurrent ? winnerOfCurrent.score : 0 }}</span>
        </div>

        <div class="score-list">
          <div
            v-for="s in state.rounds[0]?.scores || []"
            :key="s.teamId"
            class="row-s"
            :class="{ win: s.teamId === state.rounds[0]?.winnerId }"
          >
            <span>{{ s.name }}</span>
            <span class="v">{{ s.score }}</span>
          </div>
        </div>

        <div class="actions-row" style="margin-top: 22px; position: relative; z-index: 2;">
          <button class="btn" @click="goHistory">查看战绩</button>
          <button class="btn btn-primary" @click="playAgain">再 来 一 局</button>
        </div>
      </div>
    </template>

    <!-- ============ HISTORY ============ -->
    <template v-else-if="state.screen === 'history'">
      <div class="page-head">
        <button class="icon-btn" @click="state.teams.length ? state.screen = 'game' : goSetup()">←</button>
        <div class="titles" style="margin-left: 4px;">
          <span class="zh">战绩回看</span>
          <span class="en">HISTORY</span>
        </div>
      </div>

      <div v-if="winsByTeam.length === 0" class="empty">
        <div class="ico">♠</div>
        <div>还没有战绩，先打一局吧</div>
      </div>

      <template v-if="winsByTeam.length > 0">
        <div class="card-title">胜场统计</div>
        <div class="stat-grid">
          <div
            v-for="w in winsByTeam"
            :key="w.name"
            class="stat-pill"
          >
            <span class="pname">{{ w.name }}</span>
            <span class="pwins">{{ w.wins }}<span class="unit">胜</span></span>
          </div>
        </div>

        <div class="card-title">回合记录</div>
        <div class="round-list">
          <div
            v-for="(r, idx) in state.rounds"
            :key="r.id"
            class="round-card"
            :class="{ sweep: r.bigSweep }"
          >
            <div class="round-head">
              <span>第 {{ state.rounds.length - idx }} 局 · {{ formatTime(r.endedAt) }}</span>
              <span>
                <span class="winner-tag">{{ r.scores.find(s => s.teamId === r.winnerId)?.name }} 胜</span>
                <button v-if="r.bigSweep" class="sweep-badge" @click="replaySweep(r)">大剔 ✨</button>
              </span>
            </div>
            <div class="round-scores">
              <span
                v-for="s in r.scores"
                :key="s.teamId"
                :class="{ 'winner-row': s.teamId === r.winnerId, 'sweep-row': (r.sweepTeamIds || []).includes(s.teamId) }"
              >{{ s.name }}: {{ s.score }}<span v-if="(r.sweepTeamIds || []).includes(s.teamId)" class="row-sweep-tag">大剔</span></span>
            </div>
          </div>
        </div>
      </template>

      <div class="actions-row" style="margin-top: 18px;">
        <button class="btn" @click="goSetup">开局设置</button>
        <button class="btn btn-primary" @click="playAgain">再 来 一 局</button>
      </div>
    </template>

    <!-- Toast -->
    <div v-if="toastMsg" class="toast-wrap">
      <div class="toast">{{ toastMsg }}</div>
    </div>

    <!-- Modals -->
    <div v-if="showUndoConfirm" class="modal-mask" @click.self="showUndoConfirm = false">
      <div class="modal">
        <h4>撤销上一步</h4>
        <p>将撤销刚才所有队伍的最近一次提交，确认继续？</p>
        <div class="actions">
          <button class="btn" @click="showUndoConfirm = false">取消</button>
          <button class="btn btn-primary" @click="confirmUndo">撤销</button>
        </div>
      </div>
    </div>
    <div v-if="showResetConfirm" class="modal-mask" @click.self="showResetConfirm = false">
      <div class="modal">
        <h4>清空当局</h4>
        <p>当前所有分数将被清零，无法恢复，是否继续？</p>
        <div class="actions">
          <button class="btn" @click="showResetConfirm = false">取消</button>
          <button class="btn btn-warm" @click="confirmReset">清空</button>
        </div>
      </div>
    </div>
    <div v-if="showBackConfirm" class="modal-mask" @click.self="showBackConfirm = false">
      <div class="modal">
        <h4>返回开局设置</h4>
        <p>返回会清空当前所有分数，是否返回？</p>
        <div class="actions">
          <button class="btn" @click="showBackConfirm = false">取消</button>
          <button class="btn btn-warm" @click="confirmBackToSetup">返回</button>
        </div>
      </div>
    </div>

    <!-- Big sweep overlay -->
    <div v-if="sweepShown" :key="sweepKey" class="sweep-overlay" @click="sweepShown = false">
      <div class="ring"></div>
      <div class="stage">大剔</div>
      <div class="sub">{{ state.lastSweep?.winnerName || '' }} 全 胜</div>
      <span
        v-for="(p, i) in confettiPieces"
        :key="i"
        class="confetti"
        :style="{
          background: p.color,
          ['--dx' as any]: p.dx + 'px',
          ['--dy' as any]: p.dy + 'px',
          ['--rot' as any]: p.rot + 'deg',
          animationDelay: p.delay + 's'
        }"
      ></span>
      <div class="close-tip">点击任意位置关闭</div>
    </div>
  </div>
</template>
