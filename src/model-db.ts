// 翻译模型文件的本地存储：用户用 <input type=file> 选目录读入的文件统一落 IndexedDB，
// popup 写入、offscreen 翻译 worker 读取，扩展各上下文同源共享，无需任何权限。
const DB_NAME = 'tmspeech';
const DB_VERSION = 1;
const STORE = 'models';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
}

// 键 = 相对路径（webkitRelativePath），如 `opus-mt-en-zh/config.json`
export async function saveModelFile(key: string, data: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, key);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function getModelFile(key: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const raw = await new Promise<unknown>((resolve, reject) => {
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 读取失败'));
    });
    if (raw == null) return null;
    return raw instanceof Blob ? raw : new Blob([raw as ArrayBuffer]);
  } finally {
    db.close();
  }
}

export async function listModelKeys(): Promise<string[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 读取失败'));
    });
    return (keys as string[]) || [];
  } finally {
    db.close();
  }
}

export async function clearModels(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } finally {
    db.close();
  }
}
