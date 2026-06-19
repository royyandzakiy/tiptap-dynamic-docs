import './style.css'
import { Editor, Extension, Node, mergeAttributes } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  AddMarkStep,
  RemoveMarkStep,
  ReplaceStep,
  ReplaceAroundStep,
} from '@tiptap/pm/transform'
import StarterKit from '@tiptap/starter-kit'
import Paragraph from '@tiptap/extension-paragraph'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import TextAlign from '@tiptap/extension-text-align'
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

// An inline dropdown node: renders a real <select> of predefined options and
// persists the chosen value as a node attribute (survives reload / getHTML).
const StatusSelect = Node.create({
  name: 'statusSelect',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      value: {
        default: 'Open',
        parseHTML: (el) => el.getAttribute('data-value') || 'Open',
        renderHTML: (attrs) => ({ 'data-value': attrs.value }),
      },
      options: {
        default: ['Open', 'In Progress', 'Done'],
        parseHTML: (el) => {
          try {
            return JSON.parse(el.getAttribute('data-options'))
          } catch {
            return ['Open', 'In Progress', 'Done']
          }
        },
        renderHTML: (attrs) => ({ 'data-options': JSON.stringify(attrs.options) }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-type="status-select"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'status-select' })]
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span')
      dom.className = 'status-select'
      dom.contentEditable = 'false'

      const select = document.createElement('select')
      ;(node.attrs.options || []).forEach((opt) => {
        const o = document.createElement('option')
        o.value = opt
        o.textContent = opt
        if (opt === node.attrs.value) o.selected = true
        select.appendChild(o)
      })
      select.addEventListener('change', () => {
        if (typeof getPos !== 'function') return
        const tr = editor.view.state.tr.setNodeMarkup(getPos(), undefined, {
          ...node.attrs,
          value: select.value,
        })
        editor.view.dispatch(tr)
      })

      dom.appendChild(select)
      // Let the <select> handle its own events; don't let ProseMirror edit it.
      return { dom, stopEvent: () => true, ignoreMutation: () => true }
    }
  },
})

// An inline date field: a native <input type="date"> (calendar popup) whose
// chosen value is persisted as a node attribute.
const DateField = Node.create({
  name: 'dateField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      value: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-value') || '',
        renderHTML: (attrs) => ({ 'data-value': attrs.value }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-type="date-field"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'date-field' })]
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span')
      dom.className = 'date-field'
      dom.contentEditable = 'false'

      const input = document.createElement('input')
      input.type = 'date'
      if (node.attrs.value) input.value = node.attrs.value
      input.addEventListener('change', () => {
        if (typeof getPos !== 'function') return
        const tr = editor.view.state.tr.setNodeMarkup(getPos(), undefined, {
          ...node.attrs,
          value: input.value,
        })
        editor.view.dispatch(tr)
      })

      dom.appendChild(input)
      return { dom, stopEvent: () => true, ignoreMutation: () => true }
    }
  },
})

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

// Enforces "no styling" inside any node carrying class="no-style": blocks all
// mark changes (bold/italic/strike/colour/size) and insertion of non-text inline
// content (images / field widgets). Plain typing and "leave blank" still work.
const StyleGuard = Extension.create({
  name: 'styleGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(transaction, state) {
          if (!transaction.docChanged) return true
          const ranges = []
          state.doc.descendants((node, pos) => {
            if (node.attrs?.noStyle) ranges.push([pos, pos + node.nodeSize])
          })
          if (ranges.length === 0) return true
          const overlaps = (from, to) =>
            ranges.some(([a, b]) => from < b && to > a)

          for (const step of transaction.steps) {
            // Block all text marks.
            if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
              if (overlaps(step.from, step.to)) return false
              continue
            }
            // Block inserting inline non-text content (images / widgets); typing
            // text and structural edits (Enter, blankOk toggle) pass through.
            if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
              let hasInlineNonText = false
              step.slice.content.forEach((n) => {
                if (n.isInline && !n.isText) hasInlineNonText = true
              })
              if (hasInlineNonText && overlaps(step.from, step.to)) return false
            }
          }
          return true
        },
      }),
    ]
  },
})

// Floating toolbar element (managed/positioned by the BubbleMenu extension).
const svg = (inner) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

const ICONS = {
  alignLeft: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="14" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>'),
  alignCenter: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>'),
  alignRight: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>'),
  alignJustify: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  bullet: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none"/>'),
  ordered: svg('<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="2" y="8.5" font-size="8" fill="currentColor" stroke="none" font-family="sans-serif">1</text><text x="2" y="14.5" font-size="8" fill="currentColor" stroke="none" font-family="sans-serif">2</text><text x="2" y="20.5" font-size="8" fill="currentColor" stroke="none" font-family="sans-serif">3</text>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
}

const bubbleEl = document.createElement('div')
bubbleEl.className = 'bubble-menu'
bubbleEl.innerHTML = `
  <div class="bm-group">
    <button data-cmd="bold" title="Bold"><span class="bm-bold">B</span></button>
    <button data-cmd="italic" title="Italic"><span class="bm-italic">I</span></button>
    <button data-cmd="strike" title="Strikethrough"><span class="bm-strike">S</span></button>
  </div>
  <span class="sep"></span>
  <div class="bm-group">
    <select data-control="fontSize" title="Text size">
      <option value="">Size</option>
      <option value="12px">12</option>
      <option value="14px">14</option>
      <option value="16px">16</option>
      <option value="20px">20</option>
      <option value="24px">24</option>
      <option value="32px">32</option>
    </select>
    <input type="color" data-control="color" value="#1a1a1a" title="Text color" class="color-swatch" />
  </div>
  <span class="sep"></span>
  <div class="bm-group">
    <button data-cmd="align-left" title="Align left">${ICONS.alignLeft}</button>
    <button data-cmd="align-center" title="Align center">${ICONS.alignCenter}</button>
    <button data-cmd="align-right" title="Align right">${ICONS.alignRight}</button>
    <button data-cmd="align-justify" title="Justify">${ICONS.alignJustify}</button>
  </div>
  <span class="sep"></span>
  <div class="bm-group">
    <button data-cmd="bulletList" title="Bullet list">${ICONS.bullet}</button>
    <button data-cmd="orderedList" title="Numbered list">${ICONS.ordered}</button>
  </div>
  <span class="sep"></span>
  <div class="bm-group">
    <button data-action="image" title="Insert image">${ICONS.image}</button>
  </div>
  <span class="sep"></span>
  <div class="bm-group">
    <button data-action="blank" class="bm-text" title="Mark the field at the cursor as intentionally blank (turns it green)">Leave blank</button>
  </div>
`
// Mount the formatting toolbar as a fixed bar (always visible) above the editor.
document.querySelector('#editor').before(bubbleEl)

// Makes a node "trackable" simply by adding class="track" to it (works on any
// of these node types — paragraphs, headings, table cells, ...).
const Trackable = Extension.create({
  name: 'trackable',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'tableCell', 'tableHeader'],
        attributes: {
          track: {
            default: false,
            parseHTML: (el) => el.classList?.contains('track') || false,
            renderHTML: (attrs) => (attrs.track ? { class: 'track' } : {}),
          },
          blankOk: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-blank-ok') === 'true',
            renderHTML: (attrs) =>
              attrs.blankOk ? { 'data-blank-ok': 'true' } : {},
          },
          // Add class="no-style" to a node to forbid all styling: text can only
          // be typed in the fixed style; marks/alignment/images are blocked.
          noStyle: {
            default: false,
            parseHTML: (el) => el.classList?.contains('no-style') || false,
            renderHTML: (attrs) => (attrs.noStyle ? { class: 'no-style' } : {}),
          },
        },
      },
    ]
  },
})

// True when a tracked node has real content (text or an image).
function hasContent(node) {
  if (node.textContent.trim().length > 0) return true
  let media = false
  node.descendants((child) => {
    if (child.type.name === 'image') {
      media = true
      return false
    }
  })
  return media
}

// A tracked node counts as "filled" (green) if it has content OR is explicitly
// marked intentionally blank via the "Leave blank" toolbar action.
function trackedNodeFilled(node) {
  return hasContent(node) || !!node.attrs?.blankOk
}

// Colours every tracked node: pink when empty, green when filled. The colours
// update live because decorations are recomputed from state on each render.
const TrackFill = Extension.create({
  name: 'trackFill',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decos = []
            state.doc.descendants((node, pos) => {
              if (node.attrs?.track) {
                const cls = hasContent(node)
                  ? 'track-filled'
                  : node.attrs.blankOk
                    ? 'track-blank'
                    : 'track-empty'
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, { class: cls })
                )
              }
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: [
    StarterKit.configure({ paragraph: false }), // use our locked-aware paragraph instead
    LockedParagraph,
    TextStyle,
    Color,
    FontSize,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Image.configure({ inline: true }), // inline so images can sit inside a paragraph
    StatusSelect,
    DateField,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    LockedTableCell,
    LockGuard,
    StyleGuard,
    Trackable,
    TrackFill,
  ],
  content: `
    <h1 class="track no-style">Title</h1>
    <p data-locked="true">This is a paragraph 1. Start typing here (non modifiable).</p>
    <p data-locked="true">This is a paragraph 2. Start typing here (non modifiable).</p>
    <p>This is a paragraph 3. Start typing here (modifiable).</p>
    <p class="track"><img src="https://lmesh.eu/wp-content/uploads/2026/04/ISO-27001-Logo-500x500-1.webp" /></p>
    <p class="track"></p>
    <p class="track"></p>
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
        <tr>
          <td>Status</td>
          <td><span data-type="status-select" data-value="In Progress" data-options='["Open","In Progress","Done"]'></span></td>
        </tr>
        <tr>
          <td>Due date</td>
          <td><span data-type="date-field" data-value="2026-06-30"></span></td>
        </tr>
        <tr>
          <td>Required field</td>
          <td class="track"></td>
        </tr>
      </tbody>
    </table>
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
        <tr>
          <td>Status</td>
          <td><span data-type="status-select" data-value="In Progress" data-options='["Open","In Progress","Done"]'></span></td>
        </tr>
        <tr>
          <td>Due date</td>
          <td><span data-type="date-field" data-value="2026-06-30"></span></td>
        </tr>
        <tr>
          <td>Required field</td>
          <td class="track"></td>
        </tr>
      </tbody>
    </table>
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
        <tr>
          <td>Status</td>
          <td><span data-type="status-select" data-value="In Progress" data-options='["Open","In Progress","Done"]'></span></td>
        </tr>
        <tr>
          <td>Due date</td>
          <td><span data-type="date-field" data-value="2026-06-30"></span></td>
        </tr>
        <tr>
          <td>Required field</td>
          <td class="track"></td>
        </tr>
      </tbody>
    </table>
  `,
})

document.querySelector('#add-table').addEventListener('click', () => {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
})

// Append a row to the (first) table with a label cell + a dropdown cell.
document.querySelector('#add-status-row').addEventListener('click', () => {
  const { state } = editor.view
  const { schema } = state
  let tableNode = null
  let tablePos = null
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'table' && tableNode === null) {
      tableNode = node
      tablePos = pos
      return false // don't descend; first table is enough
    }
  })
  if (!tableNode) return

  const options = ['Open', 'In Progress', 'Done']
  const labelCell = schema.nodes.tableCell.create(
    null,
    schema.nodes.paragraph.create(null, schema.text('Status'))
  )
  const select = schema.nodes.statusSelect.create({ value: 'Open', options })
  const selectCell = schema.nodes.tableCell.create(
    null,
    schema.nodes.paragraph.create(null, select)
  )
  const row = schema.nodes.tableRow.create(null, [labelCell, selectCell])

  const insertPos = tablePos + tableNode.nodeSize - 1 // just before the table closes
  editor.view.dispatch(state.tr.insert(insertPos, row))
  editor.commands.focus()
})

// Insert an inline date field at the current cursor position.
document.querySelector('#insert-date').addEventListener('click', () => {
  editor.chain().focus().insertContent({ type: 'dateField', attrs: { value: '' } }).run()
})

// --- Empty-field counter -----------------------------------------------------
const counterEl = document.querySelector('#empty-counter')
function updateCounter() {
  let empty = 0
  editor.state.doc.descendants((node) => {
    if (node.attrs?.track && !trackedNodeFilled(node)) empty++
  })
  counterEl.textContent = `Empty required fields: ${empty}`
  counterEl.classList.toggle('all-done', empty === 0)
}
editor.on('update', updateCounter)
updateCounter() // initial count

// --- Image preview lightbox --------------------------------------------------
const lightbox = document.createElement('div')
lightbox.className = 'lightbox-overlay'
lightbox.hidden = true
lightbox.innerHTML = `
  <button class="lightbox-close" title="Close">&times;</button>
  <img class="lightbox-img" alt="preview" />
`
document.body.appendChild(lightbox)
const lightboxImg = lightbox.querySelector('.lightbox-img')

function openLightbox(src) {
  lightboxImg.src = src
  lightbox.hidden = false
}
function closeLightbox() {
  lightbox.hidden = true
  lightboxImg.removeAttribute('src')
}

// Click an image in the document → open the larger preview.
document.querySelector('#editor').addEventListener('click', (ev) => {
  const img = ev.target.closest('img')
  if (img && img.getAttribute('src')) openLightbox(img.getAttribute('src'))
})
// Close on backdrop / close-button click (anything except the image itself).
lightbox.addEventListener('click', (ev) => {
  if (ev.target !== lightboxImg) closeLightbox()
})
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !lightbox.hidden) closeLightbox()
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

// "Leave blank" — finds the tracked field containing the cursor and toggles its
// intentionally-blank flag (an empty field then counts as fulfilled → green).
function trackedNodeAt(selection) {
  const { $from } = selection
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d)
    if (node.attrs?.track) return { node, pos: $from.before(d) }
  }
  return null
}

// True if the selection sits inside any ancestor node carrying the given attr.
function selectionHasAttr(selection, attr) {
  const { $from } = selection
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).attrs?.[attr]) return true
  }
  return false
}

const blankBtn = bubbleEl.querySelector('[data-action="blank"]')
blankBtn.addEventListener('mousedown', (e) => e.preventDefault())
blankBtn.addEventListener('click', () => {
  const tracked = trackedNodeAt(editor.state.selection)
  if (!tracked) return
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setNodeMarkup(tracked.pos, undefined, {
        ...tracked.node.attrs,
        blankOk: !tracked.node.attrs.blankOk,
      })
      return true
    })
    .run()
})

// Reflect the current selection's formatting in the toolbar controls.
function syncToolbar() {
  // Inside a no-style node, every styling control is disabled — only the
  // "Leave blank" button remains usable.
  const noStyle = selectionHasAttr(editor.state.selection, 'noStyle')
  bubbleEl
    .querySelectorAll('button[data-cmd], [data-control], button[data-action="image"]')
    .forEach((el) => {
      el.disabled = noStyle
    })

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
    btn.classList.toggle('is-active', !noStyle && !!editor.isActive(q))
  })
  fontSizeSelect.value = editor.getAttributes('textStyle').fontSize || ''
  colorInput.value = editor.getAttributes('textStyle').color || '#1a1a1a'

  // "Leave blank" is only meaningful inside a tracked field (allowed even in
  // no-style nodes — it's the one thing the title can still do).
  const tracked = trackedNodeAt(editor.state.selection)
  blankBtn.disabled = !tracked
  blankBtn.classList.toggle('is-active', !!(tracked && tracked.node.attrs.blankOk))
}

editor.on('selectionUpdate', syncToolbar)
editor.on('transaction', syncToolbar)
syncToolbar() // initial state (toolbar is always visible now)
