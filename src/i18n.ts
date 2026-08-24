const strings: Record<string, Record<string, string>> = {
  zh_CN: {
    appTitle: '易字幕 开发版本',
    btnStart: '开始',
    btnStop: '停止',
    audioSource: '音频来源',
    sourceDesc: '从当前标签页识别字幕',
    showSubtitles: '显示字幕',
    showPunct: '标点添加',
    lock: '锁定',
    unlock: '解锁',
    font: '字体',
    modelInfo: 'Zipformer · 中英双语 · 离线',
    ready: '就绪',
    waiting: '正在等待音频',
    loadingModel: '正在加载模型',
    permissionTitle: '需要麦克风权限',
    permissionDesc: '易字幕 需要麦克风访问权限才能进行语音识别',
    permissionGrant: '授权麦克风',
    permissionGranted: '✓ 麦克风已授权，可以关闭此页面继续使用 易字幕',
    permissionRequesting: '请求中...',
    permissionFailed: '授权失败',
    error: '错误',
    statusRunning: 'Running',
    statusStopped: 'Stopped',
    // —— Hero 状态卡大状态词（待命=从未启动；已停止=启动过又停）——
    stateReady: '待命',
    // 用户实测措辞：「聆听中」改「识别中」（更贴近实际动作）
    stateRunning: '识别中',
    stateStopped: '已停止',
    // —— 外观主题（C. 主题系统色板名）——
    appearanceLabel: '外观',
    themeCyan: '青蓝',
    themeEmerald: '翡翠绿',
    themeViolet: '紫罗兰',
    themeAmber: '琥珀金',
    themeRose: '玫瑰红',
    // —— 叠层外观三模式 + 波形开关 ——
    overlayBgLabel: '叠层外观',
    overlayBgGlass: '毛玻璃',
    overlayBgSolid: '纯色',
    overlayBgOutline: '描边',
    showWaveform: '波形显示',
    // 括号写明时间方向：左=旧 右=新（与回看"上=新"互补，全面板排序语义均有文字说明）
    helpWaveform: '在顶部 Hero 卡内实时显示音量电平波形（左端更早、右端最新）。仅面板打开且识别运行时渲染，关面板即停、无后台开销；关闭后显示静止基线。',
    langSwitch: 'EN',
    transcript: '字幕记录',
    transcriptEmpty: '暂无字幕',
    // 空态第二行提示语（转写记录空态美化）；括号内写明排序方向，与全面板心智一致
    transcriptHint: '开始识别后，完成的句子会自动记录在这里（最新的在最下方）',
    copy: '复制',
    copied: '已复制',
    clearTranscript: '清空',
    disclaimer: '字幕由模型识别，不保证准确',
    resetPosition: '重置位置',
    showPrev: '显示上一句',
    prevOpacity: '透明度',
    endpointRule1: '句尾静默(秒)',
    endpointRule2: '句中静默(秒)',
    endpointRule3: '最大句长(秒)',
    secDisplay: '显示',
    secPrev: '上一句',
    secPunct: '标点/断句',
    resetEndpoint: '默认',
    // —— 设置项悬停帮助（问号气泡文案）——
    // 坑：punctNote 小字注释已升级为 helpPunct 问号帮助，旧 key 一并移除，
    // 否则留下死字符串容易让后续维护者误以为 popup 上仍有该注释。
    helpHint: '查看帮助',
    helpPunct: '开启后在识别的同时由本地标点模型即时补加标点。标点推理穿插在识别流程中同步执行，可能干扰声学识别，个别词的准确率会轻微下降；追求逐字最准可关闭。',
    helpPrev: '在画面上额外显示上一条已完成的句子，方便回看刚说过的内容；透明度越低上一句越淡，越不遮挡画面。',
    helpEndpoint1: '说话人停下、尾部静音达到该秒数时结束当前句。调小断句更快但句子偏碎；调大句子更完整，字幕定稿稍晚。',
    helpEndpoint2: '连续讲话中的短停顿达到该秒数时也会尝试断句，用于切分长段语流。调小更容易在短停顿处切句，调大减少误切但单句可能偏长。',
    helpEndpoint3: '无论是否检测到停顿，当前句累计到该时长就强制结束，避免单条字幕过长难以阅读。',
    // —— 历史检索 + 新功能开关 ——
    searchPlaceholder: '搜索历史字幕…',
    searchNoMatch: '没有匹配的字幕',
    // 坑：{n} 是占位符不是模板语法，使用方必须手动 .replace('{n}', String(n))
    searchHits: '{n} 条命中',
    showLookback: '近句回看',
    // 坑：文案必须写实——把手实际位于字幕窗左上角(content.ts top:6/left:6)，面板 unshift
    // 渲染即最新在最上；措辞口语化一句话说清"去哪找+什么顺序"
    helpLookback: '点击字幕窗左上角的小箭头展开近句回看：最新一句排在最上面，越往下越早。仅存内存不落地，零常驻开销。',
    showLatency: '延迟指示',
    helpLatency: '在字幕叠层右下角显示当前识别延迟（如 1.2s）。约每 2 秒更新一次文本，开销可忽略；不需要时可关闭以保持画面纯净。',
    // 坑：无进行中会话时切换字幕开关的反馈文案（原内联双语，此批收编进 i18n）
    overlaySavedOffline: '当前无进行中的识别，设置已保存，下次开始时生效',
    // 坑：最后两处内联运行时文案的收编；{m} 是占位符不是模板语法，
    // 使用方必须手动 .replace('{m}', String(msg.message))
    noActiveTab: '没有找到活跃标签页',
    errorPrefix: '错误：{m}',
    // —— 时间戳开关 + 主题/三模式帮助（用户要求每个新增设置项都有 ? 气泡）——
    showTimestamps: '显示时间戳',
    helpTimestamps: '在每句前显示 [分:秒] 时标，表示相对本次会话第一句的偏移；旧版本记录的句子没有时标信息，只显示纯文本。',
    helpAppearance: '更换面板强调色：影响开关选中态、滑杆填充、主按钮与命中高亮等控件配色，选择自动保存。',
    helpOverlayBg: '字幕叠层的背景样式：毛玻璃=半透明模糊底；纯色=不透明深色底；描边=无底色、仅文字描边。切换即时生效。',
  },
  en: {
    appTitle: 'EasySub 开发版本',
    btnStart: 'Start',
    btnStop: 'Stop',
    audioSource: 'Audio Source',
    sourceDesc: 'Capture subtitles from current tab',
    showSubtitles: 'Show Subtitles',
    showPunct: 'Punctuation',
    lock: 'Lock',
    unlock: 'Unlock',
    font: 'Font',
    modelInfo: 'Zipformer · CN/EN · Offline',
    ready: 'Ready',
    waiting: 'Waiting for audio',
    loadingModel: 'Loading model',
    permissionTitle: 'Microphone Access Required',
    permissionDesc: 'EasySub needs microphone access for speech recognition',
    permissionGrant: 'Grant Microphone',
    permissionGranted: '✓ Microphone authorized, you may close this page',
    permissionRequesting: 'Requesting...',
    permissionFailed: 'Authorization failed',
    error: 'Error',
    statusRunning: 'Running',
    statusStopped: 'Stopped',
    stateReady: 'Standby',
    stateRunning: 'Recognizing',
    stateStopped: 'Stopped',
    appearanceLabel: 'Appearance',
    themeCyan: 'Cyan Blue',
    themeEmerald: 'Emerald',
    themeViolet: 'Violet',
    themeAmber: 'Amber',
    themeRose: 'Rose',
    overlayBgLabel: 'Overlay Style',
    overlayBgGlass: 'Glass',
    overlayBgSolid: 'Solid',
    overlayBgOutline: 'Outline',
    showWaveform: 'Waveform',
    // 时间方向说明：左=旧 右=新（与回看"上=新"互补，全面板排序语义均有文字说明）
    helpWaveform: 'Shows a live volume waveform in the hero card (older on the left, newest on the right). Renders only while the popup is open and recognition is running — no background cost; falls back to a static baseline when off.',
    langSwitch: '中',
    transcript: 'Transcript',
    transcriptEmpty: 'No subtitles yet',
    transcriptHint: 'Finished sentences will appear here once recognition starts (newest at the bottom)',
    copy: 'Copy',
    copied: 'Copied',
    clearTranscript: 'Clear',
    disclaimer: 'Subtitles are AI-generated, accuracy not guaranteed',
    resetPosition: 'Reset Position',
    showPrev: 'Show Previous',
    prevOpacity: 'Opacity',
    endpointRule1: 'End Trail(s)',
    endpointRule2: 'Mid Trail(s)',
    endpointRule3: 'Max Len(s)',
    secDisplay: 'Display',
    secPrev: 'Previous',
    secPunct: 'Punctuation',
    resetEndpoint: 'Reset',
    helpHint: 'View help',
    helpPunct: 'When on, a local punctuation model inserts punctuation while text streams in. Its inference runs interleaved with recognition and can slightly reduce accuracy for some words; turn off for maximum per-word accuracy.',
    helpPrev: 'Shows the previous finished sentence on screen so you can glance back at what was just said. Lower opacity makes that line fainter and less obtrusive.',
    helpEndpoint1: 'Ends the current sentence once trailing silence reaches this many seconds. Lower values split sooner into shorter lines; higher values keep sentences complete but finalize subtitles later.',
    helpEndpoint2: 'Also tries to break at short pauses during continuous speech to split long passages. Lower it to cut more eagerly at brief pauses; raise it to reduce false breaks, at the cost of longer sentences.',
    helpEndpoint3: 'Force-finishes the sentence when it reaches this duration even without a detected pause, so no single subtitle line gets too long to read.',
    searchPlaceholder: 'Search transcript…',
    searchNoMatch: 'No matching subtitles',
    searchHits: '{n} hit(s)',
    showLookback: 'Lookback',
    helpLookback: 'Click the small arrow at the top-left corner of the subtitle window to open lookback: the latest line is on top, the further down the older. Memory-only, zero standing cost.',
    showLatency: 'Latency',
    helpLatency: 'Shows the current recognition latency (e.g. 1.2s) at the bottom-right of the subtitle overlay. Updates about once every 2 seconds — negligible cost; turn off for a cleaner picture.',
    overlaySavedOffline: 'No active session — saved, applies on next start',
    noActiveTab: 'No active tab found',
    errorPrefix: 'Error: {m}',
    showTimestamps: 'Show Timestamps',
    helpTimestamps: 'Shows an [mm:ss] offset before each line, relative to the first sentence of this session. Sentences recorded by older versions carry no timestamp and appear as plain text.',
    helpAppearance: 'Changes the panel accent color used by toggles, slider fills, the primary button and highlights. Your choice is saved automatically.',
    helpOverlayBg: 'Background style of the subtitle overlay: Glass = translucent blurred backdrop; Solid = opaque dark plate; Outline = no plate, outlined text only. Changes apply instantly.',
  },
};

const LANG_KEY = 'tmspeech_lang';

export async function getLang(): Promise<string> {
  const r = await chrome.storage.local.get(LANG_KEY);
  return (r[LANG_KEY] as string) || 'zh_CN';
}

export async function setLang(lang: string): Promise<void> {
  await chrome.storage.local.set({ [LANG_KEY]: lang });
}

export async function t(key: string): Promise<string> {
  const lang = await getLang();
  return strings[lang]?.[key] || strings['zh_CN']?.[key] || key;
}

export function tSync(lang: string, key: string): string {
  return strings[lang]?.[key] || strings['zh_CN']?.[key] || key;
}

export { strings };
