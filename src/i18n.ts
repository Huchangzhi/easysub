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
    langSwitch: 'EN',
    transcript: '字幕记录',
    transcriptEmpty: '暂无字幕',
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
    punctNote: '(可能降低识别准确率)',
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
    langSwitch: '中',
    transcript: 'Transcript',
    transcriptEmpty: 'No subtitles yet',
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
    punctNote: '(may reduce accuracy)',
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
