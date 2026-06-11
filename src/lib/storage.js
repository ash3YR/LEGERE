/**
 * @module storage
 * @description IndexedDB storage module for the READER app.
 * Manages two object stores – 'books' and 'annotations' – using the `idb` wrapper.
 * All public functions are async and handle errors gracefully.
 */

import { openDB } from 'idb';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_NAME = 'ReaderAppDB';
const DB_VERSION = 2;

const STORE_BOOKS = 'books';
const STORE_ANNOTATIONS = 'annotations';
const STORE_FOLDERS = 'folders';

// ---------------------------------------------------------------------------
// Lazy database promise
// ---------------------------------------------------------------------------

/** @type {Promise<import('idb').IDBPDatabase> | null} */
let dbPromise = null;

/**
 * Returns (and lazily creates) the shared database promise.
 * @returns {Promise<import('idb').IDBPDatabase>}
 */
function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        // ---- Books store ----
        if (!db.objectStoreNames.contains(STORE_BOOKS)) {
          const bookStore = db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
          bookStore.createIndex('title', 'title');
          bookStore.createIndex('addedAt', 'addedAt');
        } else if (oldVersion < 2) {
          // Clear old books that were stored with raw fileData blobs instead of paths
          transaction.objectStore(STORE_BOOKS).clear();
        }

        // ---- Annotations store ----
        if (!db.objectStoreNames.contains(STORE_ANNOTATIONS)) {
          const annotationStore = db.createObjectStore(STORE_ANNOTATIONS, { keyPath: 'id' });
          annotationStore.createIndex('bookId', 'bookId');
        }

        // ---- Folders store ----
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
          db.createObjectStore(STORE_FOLDERS, { keyPath: 'path' });
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Public API – Database initialisation
// ---------------------------------------------------------------------------

/**
 * Explicitly initialise (or verify) the database connection.
 * Calling this is optional – every other function lazily initialises the DB –
 * but it can be useful during app startup to surface connection errors early.
 *
 * @returns {Promise<void>}
 */
export async function initDB() {
  try {
    await getDB();
  } catch (err) {
    console.error('[storage] Failed to initialise database:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API – Books CRUD
// ---------------------------------------------------------------------------

/**
 * Add a new book record to the store.
 *
 * @param {Object}      params
 * @param {string}      params.title      – Display title (usually filename without .pdf)
 * @param {string}      params.fileName   – Original filename
 * @param {string}      params.path       - Absolute path to the PDF on disk
 * @param {string}      params.thumbnail  - Base-64 data URL of page-1 thumbnail
 * @param {number}      params.pageCount  - Total number of pages
 * @param {number}      params.fileSize   - File size in bytes
 * @returns {Promise<string>} The generated book id.
 */
export async function addBook({ title, fileName, path, thumbnail, pageCount, fileSize }) {
  try {
    const db = await getDB();
    const now = Date.now();

    /** @type {import('./storage').BookRecord} */
    const record = {
      id: path || crypto.randomUUID(), // Use path as ID if available to prevent duplicates
      path,
      title,
      fileName,
      thumbnail,
      pageCount,
      addedAt: now,
      lastOpenedAt: now,
      fileSize,
    };

    await db.put(STORE_BOOKS, record);
    return record.id;
  } catch (err) {
    console.error('[storage] addBook failed:', err);
    throw err;
  }
}

/**
 * Retrieve a single book by its id.
 *
 * @param {string} id – Book id.
 * @returns {Promise<Object|undefined>} The book record, or undefined if not found.
 */
export async function getBook(id) {
  try {
    const db = await getDB();
    return await db.get(STORE_BOOKS, id);
  } catch (err) {
    console.error('[storage] getBook failed:', err);
    throw err;
  }
}

/**
 * Retrieve every book in the store, sorted by `lastOpenedAt` descending
 * (most-recently-opened first).
 *
 * @returns {Promise<Object[]>} Array of book records.
 */
export async function getAllBooks() {
  try {
    const db = await getDB();
    const books = await db.getAll(STORE_BOOKS);

    // Sort in-memory – most recently opened first.
    books.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

    return books;
  } catch (err) {
    console.error('[storage] getAllBooks failed:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API – Folders
// ---------------------------------------------------------------------------

export async function addFolder(path) {
  try {
    const db = await getDB();
    await db.put(STORE_FOLDERS, { path, addedAt: Date.now() });
  } catch (err) {
    console.error('[storage] addFolder failed:', err);
    throw err;
  }
}

export async function getFolders() {
  try {
    const db = await getDB();
    return await db.getAll(STORE_FOLDERS);
  } catch (err) {
    console.error('[storage] getFolders failed:', err);
    throw err;
  }
}

/**
 * Delete a book **and** all of its associated annotations.
 *
 * @param {string} id – Book id to delete.
 * @returns {Promise<void>}
 */
export async function deleteBook(id) {
  try {
    const db = await getDB();

    // Use a single transaction that spans both stores for atomicity.
    const tx = db.transaction([STORE_BOOKS, STORE_ANNOTATIONS], 'readwrite');

    // Delete the book record itself.
    tx.objectStore(STORE_BOOKS).delete(id);

    // Delete every annotation that references this book.
    const annotationStore = tx.objectStore(STORE_ANNOTATIONS);
    const index = annotationStore.index('bookId');
    let cursor = await index.openCursor(IDBKeyRange.only(id));

    while (cursor) {
      cursor.delete();
      cursor = await cursor.continue();
    }

    await tx.done;
  } catch (err) {
    console.error('[storage] deleteBook failed:', err);
    throw err;
  }
}

/**
 * Update a book's `lastOpenedAt` timestamp to the current time.
 *
 * @param {string} id – Book id.
 * @returns {Promise<void>}
 */
export async function updateBookLastOpened(id) {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_BOOKS);

    const book = await store.get(id);
    if (!book) {
      console.warn(`[storage] updateBookLastOpened: book "${id}" not found`);
      return;
    }

    book.lastOpenedAt = Date.now();
    await store.put(book);
    await tx.done;
  } catch (err) {
    console.error('[storage] updateBookLastOpened failed:', err);
    throw err;
  }
}

/**
 * Rename a book's title.
 *
 * @param {string} id – Book id.
 * @param {string} newTitle – The new title to set.
 * @returns {Promise<void>}
 */
export async function renameBook(id, newTitle) {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_BOOKS);

    const book = await store.get(id);
    if (!book) {
      console.warn(`[storage] renameBook: book "${id}" not found`);
      return;
    }

    book.title = newTitle;
    await store.put(book);
    await tx.done;
  } catch (err) {
    console.error('[storage] renameBook failed:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API – Annotations
// ---------------------------------------------------------------------------

/**
 * Save (create or overwrite) an annotation for a specific book page.
 * The annotation id is deterministic: `${bookId}_page_${pageNum}`.
 *
 * @param {string} bookId    – Owning book id.
 * @param {number} pageNum   – 1-based page number.
 * @param {string} fabricJSON – JSON.stringify output of the Fabric.js canvas.
 * @returns {Promise<void>}
 */
export async function saveAnnotation(bookId, pageNum, fabricJSON) {
  try {
    const db = await getDB();

    /** @type {import('./storage').AnnotationRecord} */
    const record = {
      id: `${bookId}_page_${pageNum}`,
      bookId,
      pageNum,
      fabricJSON,
      updatedAt: Date.now(),
    };

    await db.put(STORE_ANNOTATIONS, record);
  } catch (err) {
    console.error('[storage] saveAnnotation failed:', err);
    throw err;
  }
}

/**
 * Retrieve the annotation for a specific book page.
 *
 * @param {string} bookId  – Book id.
 * @param {number} pageNum – 1-based page number.
 * @returns {Promise<Object|undefined>} The annotation record, or undefined.
 */
export async function getAnnotation(bookId, pageNum) {
  try {
    const db = await getDB();
    return await db.get(STORE_ANNOTATIONS, `${bookId}_page_${pageNum}`);
  } catch (err) {
    console.error('[storage] getAnnotation failed:', err);
    throw err;
  }
}

/**
 * Retrieve all annotations belonging to a given book.
 *
 * @param {string} bookId – Book id.
 * @returns {Promise<Object[]>} Array of annotation records.
 */
export async function getAllAnnotationsForBook(bookId) {
  try {
    const db = await getDB();
    return await db.getAllFromIndex(STORE_ANNOTATIONS, 'bookId', bookId);
  } catch (err) {
    console.error('[storage] getAllAnnotationsForBook failed:', err);
    throw err;
  }
}

/**
 * Delete every annotation that belongs to a given book.
 *
 * @param {string} bookId – Book id.
 * @returns {Promise<void>}
 */
export async function deleteAnnotationsForBook(bookId) {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_ANNOTATIONS, 'readwrite');
    const index = tx.objectStore(STORE_ANNOTATIONS).index('bookId');

    let cursor = await index.openCursor(IDBKeyRange.only(bookId));
    while (cursor) {
      cursor.delete();
      cursor = await cursor.continue();
    }

    await tx.done;
  } catch (err) {
    console.error('[storage] deleteAnnotationsForBook failed:', err);
    throw err;
  }
}
