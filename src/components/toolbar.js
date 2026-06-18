/**
 * READER App — Annotation Toolbar Controller
 * Manages the annotation toolbar state, tool switching, color picking, and brush configuration
 */

import { Canvas, PencilBrush, IText } from 'fabric';

/**
 * @typedef {'select'|'hand'|'pen'|'highlighter'|'eraser'|'text'} ToolType
 */

/**
 * @typedef {Object} ToolbarState
 * @property {ToolType} activeTool
 * @property {string} penColor
 * @property {string} highlightColor
 * @property {number} strokeWidth
 * @property {Array} undoStack
 * @property {Array} redoStack
 */

export class AnnotationToolbar {
  /**
   * @param {Object} options
   * @param {Function} options.onToolChange - Called when tool changes
   * @param {Function} options.onUndo - Called when undo is triggered
   * @param {Function} options.onRedo - Called when redo is triggered
   */
  constructor(options = {}) {
    /** @type {ToolbarState} */
    this.state = {
      activeTool: 'select',
      penColor: '#1a1a1a',
      highlightColor: 'rgba(255,235,59,0.35)',
      strokeWidth: 3,
      undoStack: [],
      redoStack: [],
    };

    this.onToolChange = options.onToolChange || (() => {});
    this.onUndo = options.onUndo || (() => {});
    this.onRedo = options.onRedo || (() => {});

    /** @type {Map<string, Canvas>} fabric canvas instances keyed by page number */
    this.canvases = new Map();

    /** @type {number|null} currently active/visible page */
    this.activePage = null;

    this._bindElements();
    this._bindEvents();
    this._bindKeyboard();
  }

  /**
   * Cache DOM element references
   */
  _bindElements() {
    // Toolbar containers
    this.toolbar = document.getElementById('annotation-toolbar');
    this.toolbarInner = document.getElementById('toolbar-inner');
    this.dragHandle = document.getElementById('toolbar-drag-handle');

    // Tool buttons
    this.btnUndo = document.getElementById('tool-undo');
    this.btnRedo = document.getElementById('tool-redo');
    this.btnSelect = document.getElementById('tool-select');
    this.btnHand = document.getElementById('tool-hand');
    this.btnPen = document.getElementById('tool-pen');
    this.btnHighlighter = document.getElementById('tool-highlighter');
    this.btnEraser = document.getElementById('tool-eraser');
    this.btnText = document.getElementById('tool-text');

    // Color swatches
    this.colorSwatches = document.querySelectorAll('#color-swatches .color-swatch');
    this.highlightSwatches = document.querySelectorAll('#highlight-swatches .color-swatch');

    // Stroke width
    this.strokeSlider = document.getElementById('stroke-width');
    this.strokeValueDisplay = document.getElementById('stroke-width-value');

    // All tool buttons for active state management
    this.allToolBtns = [
      this.btnSelect, this.btnHand, this.btnPen,
      this.btnHighlighter, this.btnEraser, this.btnText
    ];
  }

  /**
   * Bind click events to toolbar elements
   */
  _bindEvents() {
    // Undo/Redo
    this.btnUndo?.addEventListener('click', () => this.undo());
    this.btnRedo?.addEventListener('click', () => this.redo());

    // Tool selection
    this.btnSelect?.addEventListener('click', () => this.setTool('select'));
    this.btnHand?.addEventListener('click', () => this.setTool('hand'));
    this.btnPen?.addEventListener('click', () => this.setTool('pen'));
    this.btnHighlighter?.addEventListener('click', () => this.setTool('highlighter'));
    this.btnEraser?.addEventListener('click', () => this.setTool('eraser'));
    this.btnText?.addEventListener('click', () => this.setTool('text'));

    // Pen color swatches
    this.colorSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        this.setPenColor(swatch.dataset.color);
        // Update active swatch
        this.colorSwatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        // Auto-switch to pen tool
        if (this.state.activeTool !== 'pen') {
          this.setTool('pen');
        }
      });
    });

    // Highlight color swatches
    this.highlightSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        this.setHighlightColor(swatch.dataset.color);
        this.highlightSwatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        // Auto-switch to highlighter tool
        if (this.state.activeTool !== 'highlighter') {
          this.setTool('highlighter');
        }
      });
    });

    // Stroke width slider
    this.strokeSlider?.addEventListener('input', (e) => {
      const width = parseInt(e.target.value);
      this.state.strokeWidth = width;
      this.strokeValueDisplay.textContent = width;
      this._applyBrushSettings();
    });

    this._bindDragLogic();

    // ============================================================
    // STYLUS BARREL BUTTON / ERASER TIP SUPPORT
    // ============================================================
    let previousToolBeforeEraser = null;

    // Intercept pointer down globally before Fabric.js
    document.addEventListener('pointerdown', (e) => {
      // Check if stylus, and if right-click (barrel button = 2) or eraser tip (button = 5)
      if (e.pointerType === 'pen' && (e.button === 2 || e.button === 5 || e.buttons & 2 || e.buttons & 32)) {
        if (this.state.activeTool !== 'eraser') {
          previousToolBeforeEraser = this.state.activeTool;
          this.setTool('eraser');
        }
      }
    }, { capture: true });

    // Restore previous tool when stylus lifts or button is released
    const restoreTool = (e) => {
      if (e.pointerType === 'pen' && previousToolBeforeEraser) {
        if (!(e.buttons & 2) && !(e.buttons & 32)) {
          this.setTool(previousToolBeforeEraser);
          previousToolBeforeEraser = null;
        }
      }
    };

    document.addEventListener('pointerup', restoreTool, { capture: true });
    document.addEventListener('pointercancel', restoreTool, { capture: true });

    // Prevent native right-click menu popping up when using the barrel button in the reader
    document.getElementById('reader-view')?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  /**
   * Bind drag and drop logic to move the toolbar to screen edges
   */
  _bindDragLogic() {
    if (!this.toolbar || !this.dragHandle || !this.toolbarInner) return;

    let isDragging = false;
    let startX, startY, initialTop, initialLeft;

    this.dragHandle.addEventListener('pointerdown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = this.toolbar.getBoundingClientRect();
      initialTop = rect.top;
      initialLeft = rect.left;

      this.dragHandle.setPointerCapture(e.pointerId);

      // Temporarily remove transition and transforms during drag for 1:1 mapping
      this.toolbar.style.transition = 'none';
      this.toolbar.classList.remove('dock-top', 'dock-bottom', 'dock-left', 'dock-right');
      this.toolbar.style.transform = 'none';
      
      // Keep it fixed at its exact current rect
      this.toolbar.style.top = `${initialTop}px`;
      this.toolbar.style.left = `${initialLeft}px`;
    });

    this.dragHandle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      this.toolbar.style.top = `${initialTop + dy}px`;
      this.toolbar.style.left = `${initialLeft + dx}px`;
    });

    this.dragHandle.addEventListener('pointerup', (e) => {
      if (!isDragging) return;
      isDragging = false;
      this.dragHandle.releasePointerCapture(e.pointerId);

      // Restore transition
      this.toolbar.style.transition = '';

      // Calculate closest edge to snap to based on mouse drop position
      const distTop = e.clientY;
      const distBottom = window.innerHeight - e.clientY;
      const distLeft = e.clientX;
      const distRight = window.innerWidth - e.clientX;

      const minDist = Math.min(distTop, distBottom, distLeft, distRight);

      // Clear inline styles
      this.toolbar.style.top = '';
      this.toolbar.style.left = '';
      this.toolbar.style.transform = '';

      // Apply appropriate dock class
      if (minDist === distTop) {
        this.toolbar.classList.add('dock-top');
        this.toolbarInner.classList.remove('vertical');
      } else if (minDist === distBottom) {
        this.toolbar.classList.add('dock-bottom');
        this.toolbarInner.classList.remove('vertical');
      } else if (minDist === distLeft) {
        this.toolbar.classList.add('dock-left');
        this.toolbarInner.classList.add('vertical');
      } else {
        this.toolbar.classList.add('dock-right');
        this.toolbarInner.classList.add('vertical');
      }

      this._savePosition();
    });

    // Load saved position on init
    this._loadPosition();
  }

  _savePosition() {
    const isTop = this.toolbar.classList.contains('dock-top');
    const isBottom = this.toolbar.classList.contains('dock-bottom');
    const isLeft = this.toolbar.classList.contains('dock-left');
    const isRight = this.toolbar.classList.contains('dock-right');
    
    let pos = 'top'; // default
    if (isBottom) pos = 'bottom';
    if (isLeft) pos = 'left';
    if (isRight) pos = 'right';
    
    localStorage.setItem('toolbar-position', pos);
  }

  _loadPosition() {
    if (!this.toolbar || !this.toolbarInner) return;
    const pos = localStorage.getItem('toolbar-position') || 'top';
    
    this.toolbar.classList.remove('dock-top', 'dock-bottom', 'dock-left', 'dock-right');
    this.toolbarInner.classList.remove('vertical');
    
    this.toolbar.classList.add(`dock-${pos}`);
    if (pos === 'left' || pos === 'right') {
      this.toolbarInner.classList.add('vertical');
    }
  }

  /**
   * Bind keyboard shortcuts
   */
  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Only handle shortcuts when reader view is visible
      const readerView = document.getElementById('reader-view');
      if (readerView?.classList.contains('hidden')) return;

      // Don't intercept when typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        this.undo();
      } else if (e.ctrlKey && e.key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (!e.ctrlKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'v': this.setTool('select'); break;
          case 'h': this.setTool('hand'); break;
          case 'p': this.setTool('pen'); break;
          case 'g': this.setTool('highlighter'); break;
          case 'e': this.setTool('eraser'); break;
          case 't': this.setTool('text'); break;
        }
      }
    });
  }

  /**
   * Set the active tool
   * @param {ToolType} tool
   */
  setTool(tool) {
    this.state.activeTool = tool;

    // Update button active states
    this.allToolBtns.forEach(btn => btn?.classList.remove('active'));
    switch (tool) {
      case 'select': this.btnSelect?.classList.add('active'); break;
      case 'hand': this.btnHand?.classList.add('active'); break;
      case 'pen': this.btnPen?.classList.add('active'); break;
      case 'highlighter': this.btnHighlighter?.classList.add('active'); break;
      case 'eraser': this.btnEraser?.classList.add('active'); break;
      case 'text': this.btnText?.classList.add('active'); break;
    }

    // Apply to all fabric canvases
    this._applyToolToCanvases();
    this.onToolChange(tool);
  }

  /**
   * Set pen color
   * @param {string} color
   */
  setPenColor(color) {
    this.state.penColor = color;
    if (this.state.activeTool === 'pen') {
      this._applyBrushSettings();
    }
  }

  /**
   * Set highlighter color
   * @param {string} color
   */
  setHighlightColor(color) {
    this.state.highlightColor = color;
    if (this.state.activeTool === 'highlighter') {
      this._applyBrushSettings();
    }
  }

  /**
   * Register a Fabric.js canvas for a specific page
   * @param {number} pageNum
   * @param {Canvas} fabricCanvas
   */
  registerCanvas(pageNum, fabricCanvas) {
    this.canvases.set(pageNum, fabricCanvas);

    // Set up undo tracking on this canvas
    fabricCanvas.on('object:added', (e) => {
      if (!e.target._fromUndo) {
        this.state.undoStack.push({
          type: 'add',
          pageNum,
          objectJSON: e.target.toJSON(),
        });
        this.state.redoStack = [];
      }
    });

    // Apply current tool settings
    this._applyToolToCanvas(fabricCanvas);
  }

  /**
   * Unregister a canvas (when page is scrolled out of view)
   * @param {number} pageNum
   */
  unregisterCanvas(pageNum) {
    this.canvases.delete(pageNum);
  }

  /**
   * Apply current tool to all registered canvases
   */
  _applyToolToCanvases() {
    this.canvases.forEach((canvas) => {
      this._applyToolToCanvas(canvas);
    });
  }

  /**
   * Apply current tool settings to a single canvas
   * @param {Canvas} canvas
   */
  _applyToolToCanvas(canvas) {
    const tool = this.state.activeTool;
    const isDrawing = tool === 'pen' || tool === 'highlighter';

    // Toggle class to enable/disable touch-action: none for scrolling
    if (canvas.wrapperEl) {
      canvas.wrapperEl.classList.toggle('is-drawing', isDrawing);
    }

    switch (tool) {
      case 'select':
        canvas.isDrawingMode = false;
        canvas.selection = true;
        canvas.defaultCursor = 'default';
        canvas.forEachObject(obj => { obj.selectable = true; });
        break;

      case 'hand':
        canvas.isDrawingMode = false;
        canvas.selection = false;
        canvas.defaultCursor = 'grab';
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'pen':
        canvas.isDrawingMode = true;
        canvas.selection = false;
        canvas.freeDrawingBrush = new PencilBrush(canvas);
        canvas.freeDrawingBrush.color = this.state.penColor;
        canvas.freeDrawingBrush.width = this.state.strokeWidth;
        break;

      case 'highlighter':
        canvas.isDrawingMode = true;
        canvas.selection = false;
        canvas.freeDrawingBrush = new PencilBrush(canvas);
        canvas.freeDrawingBrush.color = this.state.highlightColor;
        canvas.freeDrawingBrush.width = Math.max(this.state.strokeWidth * 4, 16);
        break;

      case 'eraser':
        canvas.isDrawingMode = false;
        canvas.selection = false;
        canvas.defaultCursor = 'crosshair';
        canvas.forEachObject(obj => { obj.selectable = true; });
        // Eraser works by clicking on objects to delete them
        this._setupEraserMode(canvas);
        break;

      case 'text':
        canvas.isDrawingMode = false;
        canvas.selection = false;
        canvas.defaultCursor = 'text';
        canvas.forEachObject(obj => { obj.selectable = true; });
        this._setupTextMode(canvas);
        break;
    }
  }

  /**
   * Apply brush settings to all canvases in drawing mode
   */
  _applyBrushSettings() {
    this.canvases.forEach((canvas) => {
      if (canvas.isDrawingMode && canvas.freeDrawingBrush) {
        if (this.state.activeTool === 'pen') {
          canvas.freeDrawingBrush.color = this.state.penColor;
          canvas.freeDrawingBrush.width = this.state.strokeWidth;
        } else if (this.state.activeTool === 'highlighter') {
          canvas.freeDrawingBrush.color = this.state.highlightColor;
          canvas.freeDrawingBrush.width = Math.max(this.state.strokeWidth * 4, 16);
        }
      }
    });
  }

  /**
   * Set up eraser mode — drag over objects to delete
   * @param {Canvas} canvas
   */
  _setupEraserMode(canvas) {
    // Remove any previous eraser listeners
    if (canvas._eraserDownHandler) {
      canvas.off('mouse:down', canvas._eraserDownHandler);
      canvas.off('mouse:move', canvas._eraserMoveHandler);
      canvas.off('mouse:up', canvas._eraserUpHandler);
    }

    let isErasing = false;

    const eraseTarget = (opt) => {
      // In Fabric, the clicked object is directly available as opt.target
      const target = opt.target;
      if (target) {
        this.state.undoStack.push({
          type: 'remove',
          pageNum: this._getPageForCanvas(canvas),
          objectJSON: target.toJSON(),
        });
        this.state.redoStack = [];
        canvas.remove(target);
        canvas.renderAll();
      }
    };

    canvas._eraserDownHandler = (opt) => {
      if (this.state.activeTool !== 'eraser') return;
      isErasing = true;
      eraseTarget(opt);
    };

    canvas._eraserMoveHandler = (opt) => {
      if (this.state.activeTool !== 'eraser' || !isErasing) return;
      eraseTarget(opt);
    };

    canvas._eraserUpHandler = () => {
      isErasing = false;
    };

    canvas.on('mouse:down', canvas._eraserDownHandler);
    canvas.on('mouse:move', canvas._eraserMoveHandler);
    canvas.on('mouse:up', canvas._eraserUpHandler);
  }

  /**
   * Set up text tool — click to place text
   * @param {Canvas} canvas
   */
  _setupTextMode(canvas) {
    canvas.off('mouse:down', canvas._textHandler);

    canvas._textHandler = (opt) => {
      if (this.state.activeTool !== 'text') return;
      // Don't create text if clicking on existing object
      if (opt.target) return;

      const pointer = opt.scenePoint || canvas.getPointer(opt.e);
      const text = new IText('Type here...', {
        left: pointer.x,
        top: pointer.y,
        fontSize: 16,
        fill: this.state.penColor,
        fontFamily: 'Inter, sans-serif',
        editable: true,
      });
      canvas.add(text);
      canvas.setActiveObject(text);
      text.enterEditing();
      text.selectAll();
    };

    canvas.on('mouse:down', canvas._textHandler);
  }

  /**
   * Get the page number for a given canvas
   * @param {Canvas} canvas
   * @returns {number|null}
   */
  _getPageForCanvas(canvas) {
    for (const [pageNum, c] of this.canvases) {
      if (c === canvas) return pageNum;
    }
    return null;
  }

  /**
   * Undo the last action
   */
  undo() {
    if (this.state.undoStack.length === 0) return;

    const action = this.state.undoStack.pop();
    this.state.redoStack.push(action);

    const canvas = this.canvases.get(action.pageNum);
    if (!canvas) return;

    if (action.type === 'add') {
      // Remove the last added object
      const objects = canvas.getObjects();
      if (objects.length > 0) {
        const lastObj = objects[objects.length - 1];
        lastObj._fromUndo = true;
        canvas.remove(lastObj);
        canvas.renderAll();
      }
    } else if (action.type === 'remove') {
      // Re-add the removed object
      canvas.loadFromJSON(
        { objects: [action.objectJSON] },
        () => {
          const objects = canvas.getObjects();
          const restored = objects[objects.length - 1];
          if (restored) restored._fromUndo = true;
          canvas.renderAll();
        }
      );
    }

    this.onUndo();
  }

  /**
   * Redo the last undone action
   */
  redo() {
    if (this.state.redoStack.length === 0) return;

    const action = this.state.redoStack.pop();
    this.state.undoStack.push(action);

    const canvas = this.canvases.get(action.pageNum);
    if (!canvas) return;

    if (action.type === 'add') {
      // Re-add the object
      canvas.loadFromJSON(
        { objects: [action.objectJSON] },
        () => {
          const objects = canvas.getObjects();
          const restored = objects[objects.length - 1];
          if (restored) restored._fromUndo = true;
          canvas.renderAll();
        }
      );
    } else if (action.type === 'remove') {
      // Remove it again
      const objects = canvas.getObjects();
      if (objects.length > 0) {
        const lastObj = objects[objects.length - 1];
        lastObj._fromUndo = true;
        canvas.remove(lastObj);
        canvas.renderAll();
      }
    }

    this.onRedo();
  }

  /**
   * Destroy all canvases and clean up
   */
  destroy() {
    this.canvases.forEach((canvas) => {
      canvas.dispose();
    });
    this.canvases.clear();
    this.state.undoStack = [];
    this.state.redoStack = [];
  }
}
