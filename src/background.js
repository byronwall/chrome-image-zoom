const LOG_PREFIX = "[alt-image-zoom]";
const OPEN_CONTEXT_MENU_ID = "alt-image-zoom-open";
const SAVE_CONTEXT_MENU_ID = "alt-image-zoom-save";
const DB_NAME = "alt-image-zoom-library";
const DB_VERSION = 1;
const DEFAULT_FOLDER_NAME = "Inbox";

console.info(LOG_PREFIX, "background service worker loaded");

function installContextMenus(reason) {
  console.info(LOG_PREFIX, "creating context menu", reason);
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn(LOG_PREFIX, "context menu removeAll failed", chrome.runtime.lastError.message);
    }
    chrome.contextMenus.create({
      id: OPEN_CONTEXT_MENU_ID,
      title: "Open image zoom modal",
      contexts: ["image"]
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn(LOG_PREFIX, "context menu create failed", chrome.runtime.lastError.message);
        return;
      }
      console.info(LOG_PREFIX, "context menu ready");
    });
    chrome.contextMenus.create({
      id: SAVE_CONTEXT_MENU_ID,
      title: "Save image to Inbox",
      contexts: ["image"]
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn(LOG_PREFIX, "save context menu create failed", chrome.runtime.lastError.message);
      }
    });
  });
}

installContextMenus("service-worker-load");

chrome.runtime.onInstalled.addListener((details) => {
  installContextMenus(`install-update:${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  console.info(LOG_PREFIX, "browser startup");
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  console.info(LOG_PREFIX, "context menu clicked", {
    menuItemId: info.menuItemId,
    srcUrl: info.srcUrl,
    tabId: tab?.id,
    tabUrl: tab?.url
  });

  if (info.menuItemId === SAVE_CONTEXT_MENU_ID && info.srcUrl) {
    saveImageToFolder({
      src: info.srcUrl,
      title: filenameFromUrl(info.srcUrl),
      pageUrl: info.pageUrl || tab?.url || "",
      folderId: null
    })
      .then((result) => console.info(LOG_PREFIX, "context menu save result", result))
      .catch((error) => console.warn(LOG_PREFIX, "context menu save failed", error));
    return;
  }

  if (info.menuItemId !== OPEN_CONTEXT_MENU_ID || !tab?.id || !info.srcUrl) return;

  chrome.tabs.sendMessage(
    tab.id,
    {
      type: "CIM_OPEN_IMAGE_URL",
      srcUrl: info.srcUrl,
      pageUrl: info.pageUrl,
      frameUrl: info.frameUrl
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn(LOG_PREFIX, "failed to send context menu open request", chrome.runtime.lastError.message);
        return;
      }
      console.info(LOG_PREFIX, "context menu open response", response);
    }
  );
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.info(LOG_PREFIX, "runtime message", message?.type, message?.url || message?.srcUrl || "");

  if (message?.type === "CIM_FETCH_IMAGE") {
    fetchImage(message.url)
      .then(sendResponse)
      .catch((error) => {
        console.warn(LOG_PREFIX, "image fetch failed", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message?.type === "CIM_DOWNLOAD_IMAGE") {
    downloadImage(message.url, message.filename)
      .then(sendResponse)
      .catch((error) => {
        console.warn(LOG_PREFIX, "download failed", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message?.type === "CIM_LIST_LIBRARY") {
    listLibrary()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "CIM_LIST_FOLDERS") {
    listFolders()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "CIM_CREATE_FOLDER") {
    createFolder(message.name)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "CIM_SAVE_IMAGE") {
    saveImageToFolder(message)
      .then(sendResponse)
      .catch((error) => {
        console.warn(LOG_PREFIX, "save image failed", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message?.type === "CIM_SAVE_IMAGES") {
    saveImagesToFolder(message)
      .then(sendResponse)
      .catch((error) => {
        console.warn(LOG_PREFIX, "bulk save failed", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message?.type === "CIM_DELETE_FOLDER") {
    deleteFolder(message.folderId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "CIM_DELETE_STORED_IMAGE") {
    deleteStoredImage(message.imageId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("folders")) {
        db.createObjectStore("folders", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("images")) {
        const images = db.createObjectStore("images", { keyPath: "id" });
        images.createIndex("folderId", "folderId");
        images.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

async function ensureDefaultFolder(db) {
  const tx = db.transaction("folders", "readwrite");
  const store = tx.objectStore("folders");
  const folders = await requestResult(store.getAll());
  if (folders.length) {
    await txDone(tx);
    return folders[0];
  }

  const folder = {
    id: id("folder"),
    name: DEFAULT_FOLDER_NAME,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.put(folder);
  await txDone(tx);
  return folder;
}

async function getFolder(folderId) {
  const db = await openDb();
  await ensureDefaultFolder(db);
  if (folderId) {
    const tx = db.transaction("folders", "readonly");
    const folder = await requestResult(tx.objectStore("folders").get(folderId));
    await txDone(tx);
    if (folder) return folder;
  }
  const tx = db.transaction("folders", "readonly");
  const folders = await requestResult(tx.objectStore("folders").getAll());
  await txDone(tx);
  return folders.sort((a, b) => a.createdAt - b.createdAt)[0];
}

async function listLibrary() {
  const db = await openDb();
  await ensureDefaultFolder(db);
  const tx = db.transaction(["folders", "images"], "readonly");
  const folders = await requestResult(tx.objectStore("folders").getAll());
  const images = await requestResult(tx.objectStore("images").getAll());
  await txDone(tx);

  const counts = new Map();
  for (const image of images) {
    counts.set(image.folderId, (counts.get(image.folderId) || 0) + 1);
  }

  const imageRecords = await Promise.all(images.map(async (image) => {
    const buffer = await image.blob.arrayBuffer();
    return {
      id: image.id,
      folderId: image.folderId,
      title: image.title,
      src: image.src,
      pageUrl: image.pageUrl,
      type: image.type,
      size: image.size,
        width: image.width,
        height: image.height,
        hash: image.hash,
        createdAt: image.createdAt,
        bytes: Array.from(new Uint8Array(buffer))
    };
  }));

  return {
    ok: true,
    folders: folders
      .map((folder) => ({ ...folder, count: counts.get(folder.id) || 0 }))
      .sort((a, b) => a.createdAt - b.createdAt),
    images: imageRecords
      .sort((a, b) => b.createdAt - a.createdAt)
  };
}

async function listFolders() {
  const db = await openDb();
  await ensureDefaultFolder(db);
  const tx = db.transaction(["folders", "images"], "readonly");
  const folders = await requestResult(tx.objectStore("folders").getAll());
  const images = await requestResult(tx.objectStore("images").getAll());
  await txDone(tx);

  const counts = new Map();
  for (const image of images) {
    counts.set(image.folderId, (counts.get(image.folderId) || 0) + 1);
  }

  return {
    ok: true,
    folders: folders
      .map((folder) => ({ ...folder, count: counts.get(folder.id) || 0 }))
      .sort((a, b) => a.createdAt - b.createdAt)
  };
}

async function createFolder(name) {
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  if (!cleanName) throw new Error("Folder name is required");

  const db = await openDb();
  const tx = db.transaction("folders", "readwrite");
  const folders = await requestResult(tx.objectStore("folders").getAll());
  const existing = folders.find((folder) => folder.name.toLowerCase() === cleanName.toLowerCase());
  if (existing) {
    await txDone(tx);
    return { ok: true, folder: existing };
  }

  const folder = {
    id: id("folder"),
    name: cleanName,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  tx.objectStore("folders").put(folder);
  await txDone(tx);
  return { ok: true, folder };
}

async function saveImageToFolder({ src, title, pageUrl, folderId }) {
  if (!src) throw new Error("Image URL is required");
  const folder = await getFolder(folderId);
  if (!folder) throw new Error("No folder available");

  const fetched = await fetchImageBlob(src);
  const hash = await hashBlob(fetched.blob);

  const existing = await findImageByHash(folder.id, hash);
  if (existing) {
    console.info(LOG_PREFIX, "skipped duplicate image", { imageId: existing.id, folderId: folder.id, hash });
    return { ok: true, duplicate: true, imageId: existing.id, folder };
  }

  const image = {
    id: id("image"),
    folderId: folder.id,
    src,
    pageUrl: pageUrl || "",
    title: title || filenameFromUrl(src),
    type: fetched.type,
    size: fetched.blob.size,
    width: null,
    height: null,
    hash,
    blob: fetched.blob,
    createdAt: Date.now()
  };

  const db = await openDb();
  const tx = db.transaction(["images", "folders"], "readwrite");
  tx.objectStore("images").put(image);
  tx.objectStore("folders").put({ ...folder, updatedAt: Date.now() });
  await txDone(tx);
  console.info(LOG_PREFIX, "saved image", { imageId: image.id, folderId: folder.id, src });
  return { ok: true, imageId: image.id, folder };
}

async function saveImagesToFolder({ images, folderId, pageUrl }) {
  if (!Array.isArray(images) || !images.length) throw new Error("No images selected");
  const results = [];
  for (const image of images) {
    results.push(await saveImageToFolder({
      src: image.src,
      title: image.title,
      pageUrl: image.pageUrl || pageUrl || "",
      folderId
    }));
  }
  return {
    ok: true,
    saved: results.filter((result) => !result.duplicate).length,
    duplicates: results.filter((result) => result.duplicate).length,
    folder: results[0]?.folder || await getFolder(folderId)
  };
}

async function findImageByHash(folderId, hash) {
  const db = await openDb();
  const tx = db.transaction("images", "readonly");
  const images = await requestResult(tx.objectStore("images").index("folderId").getAll(folderId));
  await txDone(tx);
  return images.find((image) => image.hash === hash) || null;
}

async function deleteStoredImage(imageId) {
  if (!imageId) throw new Error("Image id is required");
  const db = await openDb();
  const tx = db.transaction("images", "readwrite");
  tx.objectStore("images").delete(imageId);
  await txDone(tx);
  return { ok: true };
}

async function deleteFolder(folderId) {
  if (!folderId) throw new Error("Folder id is required");
  const db = await openDb();
  await ensureDefaultFolder(db);

  const tx = db.transaction(["folders", "images"], "readwrite");
  const folderStore = tx.objectStore("folders");
  const imageStore = tx.objectStore("images");
  const folders = await requestResult(folderStore.getAll());
  if (folders.length <= 1) throw new Error("Cannot delete the only folder");

  const folder = folders.find((item) => item.id === folderId);
  if (!folder) throw new Error("Folder not found");

  const images = await requestResult(imageStore.index("folderId").getAll(folderId));
  for (const image of images) {
    imageStore.delete(image.id);
  }
  folderStore.delete(folderId);
  await txDone(tx);
  return { ok: true, deletedImages: images.length };
}

async function fetchImage(url) {
  console.info(LOG_PREFIX, "fetching image", url);
  const fetched = await fetchImageBlob(url);
  const buffer = await fetched.blob.arrayBuffer();
  return {
    ok: true,
    type: fetched.type,
    bytes: Array.from(new Uint8Array(buffer))
  };
}

async function fetchImageBlob(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Image request failed: ${response.status}`);
  }

  const blob = await response.blob();
  return {
    type: blob.type || response.headers.get("content-type") || "image/png",
    blob
  };
}

async function downloadImage(url, filename) {
  console.info(LOG_PREFIX, "starting download", { url, filename });
  const downloadId = await chrome.downloads.download({
    url,
    filename: filename || "image",
    saveAs: false,
    conflictAction: "uniquify"
  });
  return { ok: true, downloadId };
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const leaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    return leaf || "Image";
  } catch {
    return "Image";
  }
}

async function hashBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
