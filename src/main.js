/**
 * READER App — Main Application Entry Point
 * Orchestrates the library view, reader view, and all interactions
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerURL from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { Canvas, PencilBrush } from 'fabric';
import { initDB, addBook, getBook, getAllBooks, deleteBook, updateBookLastOpened, renameBook, saveAnnotation, getAnnotation, addFolder, getFolders } from './lib/storage.js';
import { loadPDF, renderPage, generateThumbnail, getPageCount } from './lib/pdfRenderer.js';
import { createBookCard } from './components/bookCard.js';
import { AnnotationToolbar } from './components/toolbar.js';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readDir, readFile, writeFile, writeTextFile, readTextFile, exists } from '@tauri-apps/plugin-fs';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { join } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PDFDocument } from 'pdf-lib';
import './styles/index.css';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerURL;

// ============================================================
// APP STATE
// ============================================================

const state = {
  currentView: 'library', // 'library' | 'reader'
  currentBookId: null,
  currentPDF: null,
  totalPages: 0,
  pageCanvases: new Map(), // pageNum -> { pdfCanvas, fabricCanvas }
  renderedPages: new Set(),
  toolbar: null,
  zoom: 1.0,
  saveTimeout: null,
  annotations: {}, // pageNum -> fabric JSON string
  selectedFolder: 'all', // 'all' | absolute_path_to_folder
};

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  await scanFolders(); // Scan on startup
  await renderSidebar(); // Initial sidebar render
  await loadLibrary();
  bindGlobalEvents();
});

// ============================================================
// LIBRARY VIEW
// ============================================================

/**
 * Load and display all books in the library grid, filtered by the selected folder
 */
async function loadLibrary() {
  const books = await getAllBooks();
  const grid = document.getElementById('book-grid');
  const emptyState = document.getElementById('empty-state');
  const bookCount = document.getElementById('book-count');

  // Filter based on selected folder in sidebar
  const filteredBooks = state.selectedFolder === 'all' 
    ? books 
    : books.filter(b => b.path.startsWith(state.selectedFolder));

  grid.innerHTML = '';

  if (filteredBooks.length === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    bookCount.textContent = '0 books';
    document.querySelector('.empty-title').textContent = state.selectedFolder === 'all' ? 'Your library is empty' : 'Folder is empty';
    document.querySelector('.empty-subtitle').textContent = state.selectedFolder === 'all' ? 'Upload your first PDF to get started' : 'Add PDFs to this folder to see them here';
  } else {
    emptyState.classList.add('hidden');
    grid.classList.remove('hidden');
    bookCount.textContent = `${filteredBooks.length} book${filteredBooks.length !== 1 ? 's' : ''}`;

    filteredBooks.forEach((book, index) => {
      const card = createBookCard(book, openBook, showContextMenu);
      card.style.animationDelay = `${index * 0.05}s`;
      grid.appendChild(card);
    });
  }
}

/**
 * Filter books by search query
 * @param {string} query
 */
async function filterBooks(query) {
  const books = await getAllBooks();
  const grid = document.getElementById('book-grid');
  const emptyState = document.getElementById('empty-state');

  const folderFiltered = state.selectedFolder === 'all' 
    ? books 
    : books.filter(b => b.path.startsWith(state.selectedFolder));

  const filtered = query
    ? folderFiltered.filter(b => b.title.toLowerCase().includes(query.toLowerCase()))
    : folderFiltered;

  grid.innerHTML = '';

  if (filtered.length === 0 && query) {
    emptyState.classList.remove('hidden');
    document.querySelector('.empty-title').textContent = 'No books found';
    document.querySelector('.empty-subtitle').textContent = `No results for "${query}"`;
    grid.classList.add('hidden');
  } else if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    document.querySelector('.empty-title').textContent = 'Your library is empty';
    document.querySelector('.empty-subtitle').textContent = 'Upload your first PDF to get started';
    grid.classList.add('hidden');
  } else {
    emptyState.classList.add('hidden');
    grid.classList.remove('hidden');
    filtered.forEach((book, index) => {
      const card = createBookCard(book, openBook, showContextMenu);
      card.style.animationDelay = `${index * 0.05}s`;
      grid.appendChild(card);
    });
  }
}

// ============================================================
// SIDEBAR RENDERING
// ============================================================

async function renderSidebar() {
  const folders = await getFolders();
  const folderList = document.getElementById('sidebar-folder-list');
  const allPdfBtn = document.getElementById('folder-all');
  
  if (!folderList || !allPdfBtn) return;
  
  // Clear existing items
  folderList.innerHTML = '';
  
  // Create folder elements
  folders.forEach(folder => {
    // Extract base folder name
    const folderName = folder.path.split(/[\\/]/).filter(Boolean).pop();
    
    const btn = document.createElement('button');
    btn.className = `folder-item ${state.selectedFolder === folder.path ? 'folder-item--active' : ''}`;
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      ${folderName}
    `;
    
    btn.addEventListener('click', () => {
      state.selectedFolder = folder.path;
      renderSidebar(); // Update active states
      loadLibrary(); // Filter view
      // On mobile/smaller screens, we might want to auto-collapse here
    });
    
    folderList.appendChild(btn);
  });
  
  // Update "All PDFs" active state
  allPdfBtn.className = `folder-item ${state.selectedFolder === 'all' ? 'folder-item--active' : ''}`;
  
  // Ensure "All PDFs" has event listener (only once)
  if (!allPdfBtn.dataset.bound) {
    allPdfBtn.dataset.bound = 'true';
    allPdfBtn.addEventListener('click', () => {
      state.selectedFolder = 'all';
      renderSidebar();
      loadLibrary();
    });
  }
}

// ============================================================
// FOLDER SCANNING
// ============================================================

/**
 * Scan all registered folders for new PDFs and remove deleted ones (Obsidian-style sync)
 */
async function scanFolders() {
  try {
    const folders = await getFolders();
    const existingBooks = await getAllBooks();
    const currentValidPaths = new Set();
    const successfullyScannedFolderPaths = new Set();

    // 1. Discover all current PDFs
    for (const folder of folders) {
      try {
        const entries = await readDir(folder.path);
        successfullyScannedFolderPaths.add(folder.path); // Mark folder as available

        for (const entry of entries) {
          if (entry.isFile && entry.name.toLowerCase().endsWith('.pdf')) {
            const fullPath = await join(folder.path, entry.name);
            currentValidPaths.add(fullPath);
            
            const existing = existingBooks.find(b => b.id === fullPath);
            if (!existing) {
              console.log('Adding new book:', entry.name);
              const fileData = await readFile(fullPath);
              const arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
              const { thumbnail, pageCount } = await generateThumbnail(arrayBuffer);
              await addBook({
                path: fullPath,
                title: entry.name.replace(/\.pdf$/i, ''),
                fileName: entry.name,
                thumbnail,
                pageCount,
                fileSize: fileData.byteLength
              });
            }
          }
        }
      } catch (err) {
        console.warn(`Skipping folder ${folder.path} (might be disconnected):`, err);
      }
    }

    // 2. Remove books that no longer exist on disk
    let booksRemoved = false;
    for (const book of existingBooks) {
      // Check if the book's parent folder was successfully scanned
      const parentFolderScanned = Array.from(successfullyScannedFolderPaths).some(fPath => book.path.startsWith(fPath));
      
      // If the parent folder is accessible, BUT the PDF file itself wasn't found during the scan, it means the user deleted the PDF.
      if (parentFolderScanned && !currentValidPaths.has(book.path)) {
        console.log('Removing deleted book from library:', book.title);
        await deleteBook(book.id);
        booksRemoved = true;
      }
    }
    
    // If we removed books, we might need to refresh the UI if it's currently showing them
    if (booksRemoved && state.currentView === 'library') {
      loadLibrary();
    }

  } catch (err) {
    console.error('Failed to sync folders:', err);
  }
}

/**
 * Prompt user to select a folder and add it to tracking
 */
async function handleAddFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (selected === null) return;
    
    document.getElementById('library-content').style.opacity = '0.5';
    
    await addFolder(selected);
    await scanFolders();
    await renderSidebar();
    await loadLibrary();
    
    document.getElementById('library-content').style.opacity = '1';
  } catch (err) {
    console.error('Add folder error:', err);
    alert('Failed to add folder: ' + err.message);
    document.getElementById('library-content').style.opacity = '1';
  }
}

// ============================================================
// READER VIEW
// ============================================================

/**
 * Open a book in the reader view
 * @param {string} bookId
 */
async function openBook(bookId) {
  const book = await getBook(bookId);
  if (!book) return;

  state.currentBookId = bookId;
  state.currentView = 'reader';

  // Update last opened
  await updateBookLastOpened(bookId);

  // Switch views
  document.getElementById('library-view').classList.add('hidden');
  document.getElementById('reader-view').classList.remove('hidden');
  document.getElementById('reader-title').textContent = book.title;

  // Show loading
  document.getElementById('pdf-loading').classList.remove('hidden');
  document.getElementById('pdf-pages').innerHTML = '';

  // Initialize toolbar
  if (state.toolbar) state.toolbar.destroy();
  state.toolbar = new AnnotationToolbar({
    onToolChange: (tool) => console.log('Tool changed:', tool),
  });

  try {
    // Load PDF from disk
    const fileData = await readFile(book.path);
    const arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
    const pdf = await loadPDF(arrayBuffer);
    state.currentPDF = pdf;
    state.totalPages = getPageCount(pdf);
    state.renderedPages.clear();
    state.pageCanvases.clear();

    // Load annotations from sidecar file
    const sidecarPath = `${book.path}.annotations.json`;
    state.annotations = {};
    if (await exists(sidecarPath)) {
      const text = await readTextFile(sidecarPath);
      state.annotations = JSON.parse(text);
    }

    document.getElementById('page-total').textContent = `of ${state.totalPages}`;
    const pageInput = document.getElementById('page-input');
    pageInput.max = state.totalPages;
    pageInput.value = 1;

    // Create page containers
    const pagesContainer = document.getElementById('pdf-pages');
    for (let i = 1; i <= state.totalPages; i++) {
      const pageContainer = createPageContainer(i);
      pagesContainer.appendChild(pageContainer);
    }

    // Hide loading
    document.getElementById('pdf-loading').classList.add('hidden');

    // Set up intersection observer for lazy rendering
    setupLazyRendering();

    // Auto-align the scroll dock to the main toolbar if not manually dragged
    if (window.autoAlignScrollDock) {
      // Small delay to ensure the DOM layout for the main toolbar has fully calculated its height
      setTimeout(() => window.autoAlignScrollDock(), 50);
    }

  } catch (err) {
    console.error('Failed to open book:', err);
    alert('Failed to load PDF file.');
    closeReader();
  }
}

/**
 * Create a page container with PDF canvas and annotation overlay
 * @param {number} pageNum
 * @returns {HTMLElement}
 */
function createPageContainer(pageNum) {
  const container = document.createElement('div');
  container.className = 'page-container';
  container.dataset.page = pageNum;
  container.id = `page-${pageNum}`;

  // Page number label
  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = `Page ${pageNum}`;

  // PDF rendering canvas
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.className = 'pdf-canvas';
  pdfCanvas.id = `pdf-canvas-${pageNum}`;

  // Annotation overlay canvas
  const annotCanvas = document.createElement('canvas');
  annotCanvas.className = 'annotation-canvas';
  annotCanvas.id = `annot-canvas-${pageNum}`;

  // Loading placeholder
  const placeholder = document.createElement('div');
  placeholder.className = 'page-placeholder';
  placeholder.innerHTML = '<div class="page-skeleton"></div>';

  container.appendChild(label);
  container.appendChild(pdfCanvas);
  container.appendChild(annotCanvas);
  container.appendChild(placeholder);

  return container;
}

/**
 * Set up intersection observer to lazily render pages as they scroll into view
 */
function setupLazyRendering() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(async (entry) => {
      if (entry.isIntersecting) {
        const pageNum = parseInt(entry.target.dataset.page);
        if (!state.renderedPages.has(pageNum)) {
          await renderPageInContainer(pageNum);
        }
        // Update page info
        updatePageInfo(pageNum);
      }
    });
  }, {
    root: document.getElementById('reader-content'),
    rootMargin: '200px 0px', // Pre-render pages 200px before they're visible
    threshold: 0.1,
  });

  document.querySelectorAll('.page-container').forEach(container => {
    observer.observe(container);
  });
}

/**
 * Render a PDF page and set up annotation canvas
 * @param {number} pageNum
 */
async function renderPageInContainer(pageNum) {
  if (state.renderedPages.has(pageNum)) return;
  state.renderedPages.add(pageNum);

  const container = document.getElementById(`page-${pageNum}`);
  const pdfCanvas = document.getElementById(`pdf-canvas-${pageNum}`);
  const annotCanvasEl = document.getElementById(`annot-canvas-${pageNum}`);
  const placeholder = container.querySelector('.page-placeholder');

  try {
    // Render PDF page
    const { width, height } = await renderPage(
      state.currentPDF, pageNum, pdfCanvas, state.scale
    );

    // Set container dimensions
    container.style.width = `${width}px`;
    container.style.height = `${height + 30}px`; // +30 for page label

    // Set annotation canvas dimensions to match
    annotCanvasEl.width = pdfCanvas.width;
    annotCanvasEl.height = pdfCanvas.height;
    annotCanvasEl.style.width = `${width}px`;
    annotCanvasEl.style.height = `${height}px`;

    // Initialize Fabric.js on the annotation canvas
    const fabricCanvas = new Canvas(annotCanvasEl, {
      isDrawingMode: false,
      enableRetinaScaling: true,
      allowTouchScrolling: true,
      width: width,
      height: height,
    });

    // Store reference
    state.pageCanvases.set(pageNum, { pdfCanvas, fabricCanvas });

    // Register with toolbar
    if (state.toolbar) {
      state.toolbar.registerCanvas(pageNum, fabricCanvas);
    }

    // Load existing annotations
    await loadPageAnnotations(pageNum, fabricCanvas);

    // Auto-save annotations when drawing finishes
    fabricCanvas.on('path:created', () => {
      debouncedSaveAnnotations(pageNum, fabricCanvas);
    });
    fabricCanvas.on('object:modified', () => {
      debouncedSaveAnnotations(pageNum, fabricCanvas);
    });
    fabricCanvas.on('object:removed', () => {
      debouncedSaveAnnotations(pageNum, fabricCanvas);
    });

    // Hide placeholder
    if (placeholder) placeholder.classList.add('hidden');

  } catch (err) {
    console.error(`Failed to render page ${pageNum}:`, err);
  }
}

/**
 * Load saved annotations for a page
 * @param {number} pageNum
 * @param {Canvas} fabricCanvas
 */
async function loadPageAnnotations(pageNum, fabricCanvas) {
  try {
    const jsonStr = state.annotations[pageNum];
    if (jsonStr) {
      await fabricCanvas.loadFromJSON(JSON.parse(jsonStr));
      fabricCanvas.renderAll();
      // Mark all loaded objects to avoid duplicate undo tracking
      fabricCanvas.getObjects().forEach(obj => { obj._fromUndo = true; });
    }
  } catch (err) {
    console.error(`Failed to load annotations for page ${pageNum}:`, err);
  }
}

/**
 * Save annotations with debounce to memory (Ctrl+S persists to disk)
 * @param {number} pageNum
 * @param {Canvas} fabricCanvas
 */
function debouncedSaveAnnotations(pageNum, fabricCanvas) {
  clearTimeout(state.saveTimeout);
  state.saveTimeout = setTimeout(() => {
    state.annotations[pageNum] = JSON.stringify(fabricCanvas.toJSON());
  }, 500);
}

// ============================================================
// NATIVE FILE SAVING & EXPORT
// ============================================================

async function handleSaveAnnotations() {
  if (!state.currentBookId) return;
  try {
    const sidecarPath = `${state.currentBookId}.annotations.json`;
    await writeTextFile(sidecarPath, JSON.stringify(state.annotations));
    showToast('Annotations saved!');
  } catch (err) {
    console.error('Save failed:', err);
    alert('Failed to save annotations: ' + (err.message || err));
  }
}

async function handleExportPDF() {
  if (!state.currentPDF || !state.currentBookId) return;
  try {
    const defaultPath = state.currentBookId.replace(/\.pdf$/i, '_Annotated.pdf');
    const savePath = await save({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      defaultPath
    });
    if (!savePath) return; // user cancelled
    
    showToast('Exporting PDF... Please wait');

    // 1. Read original PDF bytes
    const fileData = await readFile(state.currentBookId);
    const pdfDoc = await PDFDocument.load(fileData);

    // 2. Overlay PNGs for each page that has annotations
    for (const [pageNumStr, jsonStr] of Object.entries(state.annotations)) {
      const pageNum = parseInt(pageNumStr, 10);
      const pageIndex = pageNum - 1;
      if (pageIndex >= pdfDoc.getPages().length) continue;
      
      const page = await state.currentPDF.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      
      const tempCanvasElem = document.createElement('canvas');
      tempCanvasElem.width = viewport.width;
      tempCanvasElem.height = viewport.height;
      
      const tempFabric = new Canvas(tempCanvasElem);
      await tempFabric.loadFromJSON(JSON.parse(jsonStr));
      
      // Export as PNG
      const pngDataUrl = tempFabric.toDataURL({ format: 'png', multiplier: 2 }); // 2x for quality
      const res = await fetch(pngDataUrl);
      const pngBuffer = await res.arrayBuffer();
      
      const pngImage = await pdfDoc.embedPng(pngBuffer);
      const pdfPage = pdfDoc.getPages()[pageIndex];
      
      pdfPage.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: pdfPage.getWidth(),
        height: pdfPage.getHeight(),
      });
      tempFabric.dispose();
    }

    const pdfBytes = await pdfDoc.save();
    await writeFile(savePath, pdfBytes);
    showToast('Export complete!');
  } catch(e) {
    console.error('Export failed:', e);
    alert('Failed to export PDF: ' + (e.message || e));
  }
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-message').textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

/**
 * Update the page info display
 * @param {number} pageNum
 */
function updatePageInfo(pageNum) {
  const input = document.getElementById('page-input');
  if (input && document.activeElement !== input) {
    input.value = pageNum;
  }
}

/**
 * Close the reader view and return to library
 */
function closeReader() {
  // Save any pending annotations
  if (state.saveTimeout) {
    clearTimeout(state.saveTimeout);
    // Force save all dirty pages
    state.pageCanvases.forEach(async ({ fabricCanvas }, pageNum) => {
      try {
        const json = JSON.stringify(fabricCanvas.toJSON());
        await saveAnnotation(state.currentBookId, pageNum, json);
      } catch (err) { /* silent */ }
    });
  }

  // Cleanup
  if (state.toolbar) {
    state.toolbar.destroy();
    state.toolbar = null;
  }
  state.pageCanvases.clear();
  state.renderedPages.clear();
  state.currentPDF = null;
  state.currentBookId = null;
  state.currentView = 'library';

  // Switch views
  document.getElementById('reader-view').classList.add('hidden');
  document.getElementById('library-view').classList.remove('hidden');

  // Reload library to update "last opened"
  loadLibrary();
}

/**
 * Set the CSS zoom level of the PDF pages
 * @param {number} level
 */
function setZoom(level) {
  const scrollContainer = document.getElementById('reader-content');
  let scrollRatio = 0;
  if (scrollContainer && scrollContainer.scrollHeight > 0) {
    scrollRatio = scrollContainer.scrollTop / scrollContainer.scrollHeight;
  }

  // Clamp zoom between 0.3 and 3.0
  state.zoom = Math.max(0.3, Math.min(3.0, level));
  const pages = document.getElementById('pdf-pages');
  
  if (pages) {
    // We use the 'zoom' CSS property because Tauri uses Edge WebView2 (Chromium).
    // This perfectly recalibrates the layout and scroll container, 
    // ensuring the IntersectionObserver never loses track of the pages.
    pages.style.zoom = state.zoom;
    
    // Clear transform from previous version if it exists
    pages.style.transform = 'none';
    pages.style.marginBottom = '0px';

    // Restore scroll position so the view doesn't jump to random pages
    if (scrollContainer) {
      requestAnimationFrame(() => {
        scrollContainer.scrollTop = scrollRatio * scrollContainer.scrollHeight;
      });
    }
  }
}

// ============================================================
// MODAL & UPLOAD (DELETED - REPLACED BY NATIVE FOLDERS)
// ============================================================

// ============================================================
// CONTEXT MENU
// ============================================================

let contextMenuBookId = null;

function showContextMenu(event, book) {
  const menu = document.getElementById('context-menu');
  contextMenuBookId = book.id;

  menu.classList.remove('hidden');
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  // Ensure menu stays within viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  contextMenuBookId = null;
}

// ============================================================
// SCROLL DOCK LOGIC
// ============================================================

function initScrollDock() {
  const dock = document.getElementById('scroll-dock');
  const handle = document.getElementById('scroll-dock-handle');
  const upBtn = document.getElementById('scroll-dock-up');
  const downBtn = document.getElementById('scroll-dock-down');
  const readerContent = document.getElementById('reader-content');
  if (!dock || !handle || !upBtn || !downBtn || !readerContent) return;

  // --- Drag and Snap Logic ---
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  function handleDragStart(e) {
    isDragging = true;
    window.__scrollDockManuallyDragged = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startX = clientX;
    startY = clientY;
    const rect = dock.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    // Convert from bottom/right to top/left for absolute dragging
    dock.style.bottom = 'auto';
    dock.style.right = 'auto';
    dock.style.left = `${initialLeft}px`;
    dock.style.top = `${initialTop}px`;
    dock.classList.add('is-dragging');
    
    e.preventDefault(); // Prevent text selection and dual-firing
  }

  handle.addEventListener('mousedown', handleDragStart);
  handle.addEventListener('touchstart', handleDragStart, { passive: false });

  function handleDragMove(e) {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;
    dock.style.left = `${initialLeft + dx}px`;
    dock.style.top = `${initialTop + dy}px`;
  }

  document.addEventListener('mousemove', handleDragMove);
  document.addEventListener('touchmove', handleDragMove, { passive: false });

  function snapDock(cx, cy) {
    const readerView = document.getElementById('reader-view');
    const viewRect = readerView.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();

    const isLeft = cx < viewRect.left + viewRect.width / 2;

    dock.style.left = 'auto';
    dock.style.right = 'auto';
    dock.style.top = 'auto';
    dock.style.bottom = 'auto';

    let targetLeft = null;
    let targetRight = null;
    
    // Clamp vertical position so it stays on screen
    let targetTop = Math.max(24, Math.min(cy - dockRect.height / 2, window.innerHeight - dockRect.height - 24));

    if (isLeft) targetLeft = 24;
    else targetRight = 24;

    const mainToolbar = document.getElementById('annotation-toolbar');
    const isMainDockLeft = mainToolbar?.classList.contains('dock-left');
    const isMainDockRight = mainToolbar?.classList.contains('dock-right');
    const isMainDockTop = mainToolbar?.classList.contains('dock-top');
    const isMainDockBottom = mainToolbar?.classList.contains('dock-bottom');
    const mainRect = mainToolbar ? mainToolbar.getBoundingClientRect() : null;

    if (mainRect) {
      if (isLeft && isMainDockLeft) {
        const gap = mainRect.left;
        targetLeft = mainRect.right + gap;
      } else if (!isLeft && isMainDockRight) {
        const gap = window.innerWidth - mainRect.right;
        targetRight = window.innerWidth - mainRect.left + gap;
      }
      
      // Prevent overlap if main toolbar is at top/bottom
      if (isMainDockTop && targetTop < mainRect.bottom + 24) {
         targetTop = mainRect.bottom + 24;
      }
      if (isMainDockBottom && targetTop + dockRect.height > mainRect.top - 24) {
         targetTop = mainRect.top - dockRect.height - 24;
      }
    }

    dock.style.top = `${targetTop}px`;
    if (targetLeft !== null) dock.style.left = `${targetLeft}px`;
    if (targetRight !== null) dock.style.right = `${targetRight}px`;
  }

  function handleDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    dock.classList.remove('is-dragging');

    const rect = dock.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    
    snapDock(cx, cy);
  }

  document.addEventListener('mouseup', handleDragEnd);
  document.addEventListener('touchend', handleDragEnd);

  window.autoAlignScrollDock = () => {
    if (window.__scrollDockManuallyDragged) return;
    const mainToolbar = document.getElementById('annotation-toolbar');
    if (!mainToolbar) return;
    
    if (mainToolbar.offsetHeight === 0) return;

    let targetBottom = 'auto';
    let targetTop = 'auto';
    let targetLeft = 'auto';
    let targetRight = 'auto';
    
    const gap = 16;
    const margin = 24; // .toolbar has 24px margin to screen edges
    
    if (mainToolbar.classList.contains('dock-right')) {
      targetRight = margin + mainToolbar.offsetWidth + gap;
      targetBottom = Math.max(margin, (window.innerHeight / 2) - (mainToolbar.offsetHeight / 2));
    } else if (mainToolbar.classList.contains('dock-left')) {
      targetLeft = margin + mainToolbar.offsetWidth + gap;
      targetBottom = Math.max(margin, (window.innerHeight / 2) - (mainToolbar.offsetHeight / 2));
    } else if (mainToolbar.classList.contains('dock-top')) {
      targetTop = margin + mainToolbar.offsetHeight + gap;
      targetRight = margin;
    } else if (mainToolbar.classList.contains('dock-bottom')) {
      targetBottom = margin + mainToolbar.offsetHeight + gap;
      targetRight = margin;
    } else {
      // Fallback
      targetBottom = margin;
      targetRight = margin + mainToolbar.offsetWidth + gap;
    }

    dock.style.top = targetTop === 'auto' ? 'auto' : `${targetTop}px`;
    dock.style.bottom = targetBottom === 'auto' ? 'auto' : `${targetBottom}px`;
    dock.style.left = targetLeft === 'auto' ? 'auto' : `${targetLeft}px`;
    dock.style.right = targetRight === 'auto' ? 'auto' : `${targetRight}px`;
  };

  // --- Smooth Scrolling Logic ---
  let scrollRAF = null;
  let scrollSpeed = 0;

  function scrollLoop() {
    if (scrollSpeed !== 0) {
      readerContent.scrollBy({ top: scrollSpeed, behavior: 'instant' });
      scrollRAF = requestAnimationFrame(scrollLoop);
    }
  }

  function startScroll(speed) {
    return (e) => {
      e.preventDefault(); // Prevent native touch scrolling and dual-firing
      if (scrollRAF) cancelAnimationFrame(scrollRAF);
      scrollSpeed = speed;
      scrollRAF = requestAnimationFrame(scrollLoop);
    };
  }

  function stopScroll() {
    scrollSpeed = 0;
    if (scrollRAF) {
      cancelAnimationFrame(scrollRAF);
      scrollRAF = null;
    }
  }

  upBtn.addEventListener('mousedown', startScroll(-15));
  upBtn.addEventListener('touchstart', startScroll(-15), { passive: false });
  downBtn.addEventListener('mousedown', startScroll(15));
  downBtn.addEventListener('touchstart', startScroll(15), { passive: false });
  
  // Stop scrolling on mouse up or mouse leave
  [upBtn, downBtn].forEach(btn => {
    btn.addEventListener('mouseup', stopScroll);
    btn.addEventListener('mouseleave', stopScroll);
    btn.addEventListener('touchend', stopScroll);
    btn.addEventListener('touchcancel', stopScroll);
  });
}

// ============================================================
// GLOBAL EVENT BINDINGS
// ============================================================

function bindGlobalEvents() {
  initScrollDock();
  // Search
  const searchInput = document.getElementById('search-input');
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => filterBooks(e.target.value), 300);
  });

  // Add Folder buttons
  document.getElementById('sidebar-add-folder')?.addEventListener('click', handleAddFolder);
  document.getElementById('fab-upload')?.addEventListener('click', handleAddFolder);
  document.getElementById('empty-upload-btn')?.addEventListener('click', handleAddFolder);
  
  // Sidebar Toggles
  const sidebar = document.getElementById('app-sidebar');
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    sidebar.classList.remove('is-collapsed');
  });
  document.getElementById('sidebar-close')?.addEventListener('click', () => {
    sidebar.classList.add('is-collapsed');
  });

  document.getElementById('sidebar-info-btn')?.addEventListener('click', () => {
    document.getElementById('about-modal')?.classList.remove('hidden');
  });

  document.getElementById('about-close')?.addEventListener('click', () => {
    document.getElementById('about-modal')?.classList.add('hidden');
  });

  document.getElementById('github-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await openUrl(e.currentTarget.href);
    } catch (err) {
      console.error('Failed to open external link:', err);
    }
  });

  // Reader actions
  document.getElementById('reader-save-btn')?.addEventListener('click', handleSaveAnnotations);
  document.getElementById('reader-export-btn')?.addEventListener('click', handleExportPDF);
  document.getElementById('reader-back-btn')?.addEventListener('click', closeReader);

  document.getElementById('reader-dark-mode-btn')?.addEventListener('click', (e) => {
    document.body.classList.toggle('dark-reader');
    e.currentTarget.classList.toggle('active');
  });

  // Top bar toggle
  document.getElementById('topbar-toggle-btn')?.addEventListener('click', (e) => {
    const header = document.getElementById('reader-header');
    const btn = e.currentTarget;
    header.classList.toggle('is-collapsed');
    btn.classList.toggle('is-collapsed');
  });

  // Fullscreen toggle
  async function toggleAppFullscreen(forceState = null) {
    try {
      const appWindow = getCurrentWindow();
      const isFullscreen = await appWindow.isFullscreen();
      const newState = forceState !== null ? forceState : !isFullscreen;
      if (isFullscreen === newState) return;
      
      await appWindow.setFullscreen(newState);
      document.getElementById('fullscreen-toggle-btn')?.classList.toggle('is-active', newState);
      
      // Hide headers in fullscreen mode
      const readerHeader = document.getElementById('reader-header');
      if (readerHeader) readerHeader.style.display = newState ? 'none' : '';
      
      // Recalculate dock position if reader is open
      if (window.autoAlignScrollDock) {
        setTimeout(() => window.autoAlignScrollDock(), 100);
      }
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err);
    }
  }

  document.getElementById('fullscreen-toggle-btn')?.addEventListener('click', () => {
    toggleAppFullscreen();
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      if (state.currentView === 'reader') {
        handleSaveAnnotations();
      }
    }
  });

  // Page input jump
  document.getElementById('page-input')?.addEventListener('change', (e) => {
    let pageNum = parseInt(e.target.value, 10);
    if (isNaN(pageNum)) return;
    pageNum = Math.max(1, Math.min(pageNum, state.totalPages));
    e.target.value = pageNum;
    
    const pageEl = document.getElementById(`page-${pageNum}`);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  // Add Zoom button handlers
  document.getElementById('tool-zoom-in')?.addEventListener('click', () => {
    setZoom(state.zoom + 0.1);
  });
  
  document.getElementById('tool-zoom-out')?.addEventListener('click', () => {
    setZoom(Math.max(0.2, state.zoom - 0.1));
  });

  // Context menu actions
  document.getElementById('ctx-open').addEventListener('click', () => {
    if (contextMenuBookId) openBook(contextMenuBookId);
    hideContextMenu();
  });

  document.getElementById('ctx-rename').addEventListener('click', async () => {
    if (!contextMenuBookId) return;
    const book = await getBook(contextMenuBookId);
    const newTitle = prompt('Enter new title:', book.title);
    if (newTitle && newTitle.trim()) {
      await renameBook(contextMenuBookId, newTitle.trim());
      loadLibrary();
    }
    hideContextMenu();
  });

  document.getElementById('ctx-delete').addEventListener('click', async () => {
    if (!contextMenuBookId) return;
    const confirmed = confirm('Are you sure you want to delete this book?');
    if (confirmed) {
      await deleteBook(contextMenuBookId);
      loadLibrary();
    }
    hideContextMenu();
  });

  // Close context menu on click elsewhere
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) {
      hideContextMenu();
    }
  });

  // Keydown events (Escape and F)
  document.addEventListener('keydown', async (e) => {
    // F key to toggle fullscreen
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Don't trigger if typing in an input field
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      
      toggleAppFullscreen();
      return;
    }

    // Zoom shortcuts
    if (e.key === '=' || e.key === '+') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (state.currentView === 'reader') {
        setZoom(state.zoom + 0.1);
        e.preventDefault();
      }
      return;
    }

    if (e.key === '-') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (state.currentView === 'reader') {
        setZoom(Math.max(0.2, state.zoom - 0.1));
        e.preventDefault();
      }
      return;
    }

    // ArrowLeft to go back to library
    if (e.key === 'ArrowLeft') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (state.currentView === 'reader') {
        closeReader();
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'Escape') {
      toggleAppFullscreen(false);

      hideContextMenu();
      if (document.getElementById('upload-modal').classList.contains('hidden') === false) {
        closeModal();
      } else if (document.getElementById('about-modal').classList.contains('hidden') === false) {
        document.getElementById('about-modal').classList.add('hidden');
      } else if (state.currentView === 'reader') {
        closeReader();
      }
    }
  });

  // Prevent default drag behavior on window
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
