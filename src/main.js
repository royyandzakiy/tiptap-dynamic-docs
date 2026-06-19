import './style.css'
import { Editor, Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Paragraph from '@tiptap/extension-paragraph'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import TextAlign from '@tiptap/extension-text-align'
import BubbleMenu from '@tiptap/extension-bubble-menu'
import Image from '@tiptap/extension-image'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'

// Custom font-size mark on top of TextStyle (no official extension in v2 core).
const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] }
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el) => el.style.fontSize || null,
            renderHTML: (attrs) =>
              attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      setFontSize:
        (size) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    }
  },
})

// Adds a boolean `locked` attribute to a node, round-tripped via `data-locked`.
// Locked nodes get a `data-locked` attribute + class so we can style/detect them.
function withLockedAttr(extension) {
  return extension.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        locked: {
          default: false,
          parseHTML: (el) => el.getAttribute('data-locked') === 'true',
          renderHTML: (attrs) =>
            attrs.locked ? { 'data-locked': 'true', class: 'locked' } : {},
        },
      }
    },
  })
}

const LockedParagraph = withLockedAttr(Paragraph)
const LockedTableCell = withLockedAttr(TableCell)

// Rejects any transaction whose changes overlap a locked node's range.
// filterTransaction is a ProseMirror *plugin* hook (not an editorProp), so it
// must be registered via a Plugin for ProseMirror to actually consult it.
const LockGuard = Extension.create({
  name: 'lockGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(transaction, state) {
          if (!transaction.docChanged) return true // selection-only changes are fine

          // Collect the document ranges occupied by locked nodes.
          const lockedRanges = []
          state.doc.descendants((node, pos) => {
            if (node.attrs.locked) lockedRanges.push([pos, pos + node.nodeSize])
          })
          if (lockedRanges.length === 0) return true

          const overlaps = (from, to) =>
            lockedRanges.some(([a, b]) => from < b && to > a)

          // Block the transaction if any step touches a locked range. We can't
          // rely on the step map alone: mark steps (bold/color/size) and attr
          // steps (alignment) don't move positions, so they expose their
          // affected range via from/to or pos instead of the map.
          for (const step of transaction.steps) {
            if (step.from != null && step.to != null) {
              if (overlaps(step.from, step.to)) return false // replace + mark steps
            } else if (step.pos != null) {
              if (overlaps(step.pos, step.pos + 1)) return false // attr steps
            } else {
              let hit = false
              step.getMap().forEach((from, to) => {
                if (overlaps(from, to)) hit = true
              })
              if (hit) return false
            }
          }
          return true
        },
      }),
    ]
  },
})

// Floating toolbar element (managed/positioned by the BubbleMenu extension).
const bubbleEl = document.createElement('div')
bubbleEl.className = 'bubble-menu'
bubbleEl.innerHTML = `
  <button data-cmd="bold" title="Bold"><b>B</b></button>
  <button data-cmd="italic" title="Italic"><i>I</i></button>
  <button data-cmd="strike" title="Strikethrough"><s>S</s></button>
  <span class="sep"></span>
  <select data-control="fontSize" title="Text size">
    <option value="">Size</option>
    <option value="12px">12</option>
    <option value="14px">14</option>
    <option value="16px">16</option>
    <option value="20px">20</option>
    <option value="24px">24</option>
    <option value="32px">32</option>
  </select>
  <label class="color-btn" title="Text color">
    A<input type="color" data-control="color" value="#1a1a1a" />
  </label>
  <span class="sep"></span>
  <button data-cmd="align-left" title="Align left">⯇</button>
  <button data-cmd="align-center" title="Align center">≡</button>
  <button data-cmd="align-right" title="Align right">⯈</button>
  <button data-cmd="align-justify" title="Justify">☰</button>
  <span class="sep"></span>
  <button data-cmd="bulletList" title="Bullet list">•</button>
  <button data-cmd="orderedList" title="Numbered list">1.</button>
  <span class="sep"></span>
  <button data-action="image" title="Insert image"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></button>
`
document.body.appendChild(bubbleEl)

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: [
    StarterKit.configure({ paragraph: false }), // use our locked-aware paragraph instead
    LockedParagraph,
    TextStyle,
    Color,
    FontSize,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Image,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    LockedTableCell,
    LockGuard,
    BubbleMenu.configure({ element: bubbleEl, tippyOptions: { duration: 100 } }),
  ],
  content: `
    <h1>Title</h1>
    <p data-locked="true">This is a paragraph 1. Start typing here (non modifiable).</p>
    <p data-locked="true">This is a paragraph 2. Start typing here (non modifiable).</p>
    <p>This is a paragraph 3. Start typing here (modifiable).</p>
    <table>
      <tbody>
        <tr>
          <th>Name</th>
          <th>Value</th>
        </tr>
        <tr>
          <td data-locked="true">Cell A (non modifiable)</td>
          <td>Cell B (modifiable)</td>
        </tr>
      </tbody>
    </table>
  `,
})

document.querySelector('#add-table').addEventListener('click', () => {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
})

// --- Floating toolbar behaviour ---------------------------------------------

// Map each button's data-cmd to the editor command it runs.
const runCommand = {
  bold: (c) => c.toggleBold(),
  italic: (c) => c.toggleItalic(),
  strike: (c) => c.toggleStrike(),
  'align-left': (c) => c.setTextAlign('left'),
  'align-center': (c) => c.setTextAlign('center'),
  'align-right': (c) => c.setTextAlign('right'),
  'align-justify': (c) => c.setTextAlign('justify'),
  bulletList: (c) => c.toggleBulletList(),
  orderedList: (c) => c.toggleOrderedList(),
}

bubbleEl.querySelectorAll('button[data-cmd]').forEach((btn) => {
  // Prevent the button from stealing focus / collapsing the selection.
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', () => {
    runCommand[btn.dataset.cmd](editor.chain().focus()).run()
  })
})

// Image insertion popup (a tiny modal asking for a URL).
const imgModal = document.createElement('div')
imgModal.className = 'img-modal-overlay'
imgModal.hidden = true
imgModal.innerHTML = `
  <div class="img-modal">
    <h3>Insert image</h3>
    <input type="url" placeholder="https://example.com/image.jpg" />
    <div class="img-modal-actions">
      <button data-modal="cancel">Cancel</button>
      <button data-modal="insert">Insert</button>
    </div>
  </div>
`
document.body.appendChild(imgModal)
const imgInput = imgModal.querySelector('input')

function openImageModal() {
  imgInput.value = ''
  imgModal.hidden = false
  imgInput.focus()
}
function closeImageModal() {
  imgModal.hidden = true
}
function insertImage() {
  const src = imgInput.value.trim()
  if (src) {
    // Insert after the current selection so selected text isn't replaced.
    const { to } = editor.state.selection
    editor.chain().focus().insertContentAt(to, { type: 'image', attrs: { src } }).run()
  }
  closeImageModal()
}

bubbleEl.querySelector('[data-action="image"]').addEventListener('mousedown', (e) => e.preventDefault())
bubbleEl.querySelector('[data-action="image"]').addEventListener('click', openImageModal)
imgModal.querySelector('[data-modal="insert"]').addEventListener('click', insertImage)
imgModal.querySelector('[data-modal="cancel"]').addEventListener('click', closeImageModal)
imgModal.addEventListener('click', (e) => {
  if (e.target === imgModal) closeImageModal() // click backdrop to dismiss
})
imgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') insertImage()
  if (e.key === 'Escape') closeImageModal()
})

const fontSizeSelect = bubbleEl.querySelector('[data-control="fontSize"]')
fontSizeSelect.addEventListener('mousedown', (e) => e.stopPropagation())
fontSizeSelect.addEventListener('change', () => {
  const v = fontSizeSelect.value
  const chain = editor.chain().focus()
  if (v) chain.setFontSize(v).run()
  else chain.unsetFontSize().run()
})

const colorInput = bubbleEl.querySelector('[data-control="color"]')
colorInput.addEventListener('input', () => {
  editor.chain().focus().setColor(colorInput.value).run()
})

// Reflect the current selection's formatting in the toolbar controls.
function syncToolbar() {
  const map = {
    bold: 'bold',
    italic: 'italic',
    strike: 'strike',
    'align-left': { textAlign: 'left' },
    'align-center': { textAlign: 'center' },
    'align-right': { textAlign: 'right' },
    'align-justify': { textAlign: 'justify' },
    bulletList: 'bulletList',
    orderedList: 'orderedList',
  }
  bubbleEl.querySelectorAll('button[data-cmd]').forEach((btn) => {
    const q = map[btn.dataset.cmd]
    const active =
      typeof q === 'string' ? editor.isActive(q) : editor.isActive(q)
    btn.classList.toggle('is-active', !!active)
  })
  fontSizeSelect.value = editor.getAttributes('textStyle').fontSize || ''
  colorInput.value = editor.getAttributes('textStyle').color || '#1a1a1a'
}

editor.on('selectionUpdate', syncToolbar)
editor.on('transaction', syncToolbar)
