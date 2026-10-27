import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import {
  createEditor,
  Editor,
  Node,
  Range,
  Text,
  Transforms,
  type BaseEditor,
  type Descendant,
  type NodeEntry,
  type Point,
} from 'slate';
import { HistoryEditor, withHistory } from 'slate-history';
import {
  Editable,
  ReactEditor,
  Slate,
  useSlate,
  withReact,
  type RenderElementProps,
  type RenderLeafProps,
  type RenderPlaceholderProps,
} from 'slate-react';
import { markdownSegments, type MdMark, type MdSegment } from '@diskort/client-core';
import { cn } from '../../lib/utils';

// Yazma kutusunun zengin metin editörü (Discord gibi canlı biçim). Değer düz metindir: her satır bir
// Slate paragrafı (tek metin düğümü), satırlar `\n` ile birleşir. Biçim modele hiç yazılmaz; yalnızca
// `decorate` ile `markdownSegments` parçalarından çizilir, böylece gönderilen metin tam yazılandır.

type LineElement = { type: 'line'; children: LineText[] };
/** `md`: süsleme ile gelen işaretler (boşlukla ayrılmış `MdMark`'lar); modelde hiç bulunmaz */
type LineText = { text: string; md?: string };

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor;
    Element: LineElement;
    Text: LineText;
  }
}

const toNodes = (text: string): LineElement[] =>
  text.split(/\r\n|\r|\n/).map((line) => ({ type: 'line', children: [{ text: line }] }));

/** Editördeki düz metin */
export const editorText = (editor: Editor): string => editor.children.map((n) => Node.string(n)).join('\n');

const textLength = (editor: Editor): number =>
  editor.children.reduce((sum, n, i) => sum + Node.string(n).length + (i > 0 ? 1 : 0), 0);

/** Düz metindeki konumu editör noktasına çevirir (her satır tek metin düğümüdür) */
function toPoint(editor: Editor, offset: number): Point {
  let rest = Math.max(0, offset);
  for (let i = 0; i < editor.children.length; i++) {
    const len = Node.string(editor.children[i]!).length;
    if (rest <= len) return { path: [i, 0], offset: rest };
    rest -= len + 1;
  }
  return Editor.end(editor, []);
}

/** Editör noktasını düz metindeki konuma çevirir */
function toOffset(editor: Editor, point: Point): number {
  const line = point.path[0] ?? 0;
  let offset = 0;
  for (let i = 0; i < line; i++) offset += Node.string(editor.children[i]!).length + 1;
  // Satırda birden çok metin düğümü olursa (olmamalı) öncekilerin uzunluğu da eklenir
  const leaf = point.path[1] ?? 0;
  const el = editor.children[line];
  if (el && !Text.isText(el)) for (let j = 0; j < leaf; j++) offset += Node.string(el.children[j] ?? { text: '' }).length;
  return offset + point.offset;
}

function selectionOffsets(editor: Editor): { start: number; end: number } {
  if (!editor.selection) {
    const end = textLength(editor);
    return { start: end, end };
  }
  const [start, end] = Range.edges(editor.selection);
  return { start: toOffset(editor, start), end: toOffset(editor, end) };
}

/** Seçimin yerine düz metin ekler (satır sonları yeni satır olur); sınır aşılırsa fazlası kesilir */
function insertPlain(editor: Editor, text: string, maxLength: number | undefined): void {
  let insert = text.replace(/\r\n|\r/g, '\n');
  if (maxLength !== undefined) {
    const { start, end } = selectionOffsets(editor);
    const room = maxLength - (textLength(editor) - (end - start));
    insert = insert.slice(0, Math.max(0, room));
  }
  if (editor.selection && !Range.isCollapsed(editor.selection)) Editor.deleteFragment(editor);
  if (!insert) return;
  insert.split('\n').forEach((line, i) => {
    if (i > 0) Transforms.splitNodes(editor, { always: true });
    if (line) Transforms.insertText(editor, line);
  });
}

/**
 * Sınırı yeni satırda ve yapıştırmada uygular; yapıştırma her zaman düz metin olarak eklenir. Tek tek
 * yazılan karakterler kesilmez: Slate bazılarını (ve IME bileşimini) önce tarayıcıya DOM'a yazdırır,
 * modelde yutulursa ekran ile gönderilecek metin ayrışır. Fazlası sayaçta görünür, gönderim engellenir.
 */
function withPlainText(editor: Editor, limit: { current: number | undefined }): Editor {
  const { insertBreak } = editor;
  editor.insertBreak = () => {
    const max = limit.current;
    if (max !== undefined) {
      const { start, end } = selectionOffsets(editor);
      if (textLength(editor) - (end - start) >= max) return;
    }
    insertBreak();
  };
  editor.insertSoftBreak = () => editor.insertBreak();
  // Slate parçası ya da HTML yerine yalnızca düz metin
  editor.insertData = (data) => {
    const text = data.getData('text/plain');
    if (text) insertPlain(editor, text, limit.current);
  };
  return editor;
}

// ---------- Çizim ----------

/** Gönderilmiş mesajdaki (features/messages/markdown.tsx) görünümle aynı renk ve sınıflar */
function leafClass(marks: Set<string>): string {
  return cn(
    marks.has('bold') && 'font-bold',
    marks.has('italic') && 'italic',
    (marks.has('code') || marks.has('codeblock')) && 'font-mono text-[0.85em]',
    marks.has('code') && !marks.has('codeblock') && 'bg-bg-input',
    marks.has('spoiler') && 'rounded-sm bg-bg-input',
    marks.has('link') && 'text-link',
    marks.has('mention') && 'rounded-[3px] bg-brand/20 font-medium text-mention',
    // İşaretler (`**`, `~~`, `||`, `` ` ``, `> `) görünür ama soluk
    marks.has('marker') && 'text-text-muted',
  );
}

function Leaf({ attributes, children, leaf }: RenderLeafProps) {
  if (!leaf.md) return <span {...attributes}>{children}</span>;
  const marks = new Set(leaf.md.split(' '));
  const decoration = [marks.has('underline') && 'underline', marks.has('strike') && 'line-through']
    .filter(Boolean)
    .join(' ');
  return (
    <span
      {...attributes}
      className={leafClass(marks)}
      style={decoration ? { textDecorationLine: decoration } : undefined}
    >
      {children}
    </span>
  );
}

// Satırın blok görünümü (alıntı çizgisi, kod bloğu kutusu) satıra `data-md` ile verilir (bkz. useLineKinds)
function Line({ attributes, children }: RenderElementProps) {
  return (
    <div
      {...attributes}
      className={cn(
        'relative',
        'data-[md=quote]:border-l-4 data-[md=quote]:border-text-faint/60 data-[md=quote]:pl-3',
        'data-[md^=code]:border-x data-[md^=code]:border-edge data-[md^=code]:bg-bg-side data-[md^=code]:px-2',
        'data-[md=code-first]:mt-1 data-[md=code-first]:rounded-t data-[md=code-first]:border-t data-[md=code-first]:pt-1',
        'data-[md=code-last]:mb-1 data-[md=code-last]:rounded-b data-[md=code-last]:border-b data-[md=code-last]:pb-1',
        'data-[md=code-only]:my-1 data-[md=code-only]:rounded data-[md=code-only]:border-y data-[md=code-only]:py-1',
      )}
    >
      {children}
    </div>
  );
}

const PLACEHOLDER_STYLE: CSSProperties = { opacity: 1 };

function Placeholder({ attributes, children }: RenderPlaceholderProps) {
  return (
    <span {...attributes} style={{ ...attributes.style, ...PLACEHOLDER_STYLE }} className="truncate text-text-faint">
      {children}
    </span>
  );
}

/** Her satırın global başlangıç konumu */
function lineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return starts;
}

/** `offset`'i içeren (ya da ondan sonraki ilk) parçanın sırası */
function firstSegment(segments: readonly MdSegment[], offset: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Satırın blok türü: tamamı alıntı ya da kod bloğu içindeyse */
function lineKinds(lines: readonly string[], starts: readonly number[], segments: readonly MdSegment[]): (string | null)[] {
  const has = (offset: number, mark: MdMark): boolean => {
    const s = segments[firstSegment(segments, offset)];
    return !!s && s.start <= offset && s.marks.includes(mark);
  };
  const code = lines.map((line, i) => {
    // Boş satır: satır sonu karakteri kod bloğunun içindeyse (son satırın satır sonu yoktur)
    const at = starts[i]!;
    return line.length > 0 ? has(at, 'codeblock') : i < lines.length - 1 && has(at, 'codeblock');
  });
  return lines.map((line, i) => {
    if (code[i]) {
      const first = !code[i - 1];
      const last = !code[i + 1];
      return first && last ? 'code-only' : first ? 'code-first' : last ? 'code-last' : 'code';
    }
    return line.length > 0 && has(starts[i]!, 'quote') ? 'quote' : null;
  });
}

// ---------- Bileşen ----------

export interface MarkdownEditorHandle {
  focus(): void;
  /** Editördeki düz metin */
  getText(): string;
  /** Seçimin düz metindeki konumu (seçim yoksa metnin sonu) */
  getSelection(): { start: number; end: number };
  /** `[start, end)` aralığını metinle değiştirir, imleci sonuna koyar ve odaklanır (geri alınabilir) */
  replace(start: number, end: number, text: string): void;
  /** Metnin tamamını değiştirir; geri alma geçmişi silinir (ör. gönderdikten sonra) */
  reset(text: string): void;
}

interface Props {
  initialValue: string;
  /** Metin ya da imleç değişince; `textChanged` yalnızca metin değiştiyse true */
  onChange?: (text: string, caret: number, textChanged: boolean) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Yazılabilecek en fazla karakter (satır sonları dahil) */
  maxLength?: number;
  className?: string;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { initialValue, onChange, onKeyDown, onPaste, placeholder, autoFocus, maxLength, className },
  handle,
) {
  const limit = useRef(maxLength);
  limit.current = maxLength;
  const [editor] = useState(() => withPlainText(withHistory(withReact(createEditor())), limit));
  const [initial] = useState<Descendant[]>(() => toNodes(initialValue));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const focus = useCallback((): void => {
    if (!editor.selection) Transforms.select(editor, Editor.end(editor, []));
    ReactEditor.focus(editor);
  }, [editor]);

  useImperativeHandle(
    handle,
    () => ({
      focus,
      getText: () => editorText(editor),
      getSelection: () => selectionOffsets(editor),
      replace: (start, end, text) => {
        Transforms.select(editor, { anchor: toPoint(editor, start), focus: toPoint(editor, end) });
        insertPlain(editor, text, limit.current);
        focus();
      },
      reset: (text) => {
        HistoryEditor.withoutSaving(editor, () => {
          Editor.withoutNormalizing(editor, () => {
            Transforms.deselect(editor);
            for (let i = editor.children.length - 1; i >= 0; i--) Transforms.removeNodes(editor, { at: [i] });
            Transforms.insertNodes(editor, toNodes(text), { at: [0] });
          });
          Transforms.select(editor, Editor.end(editor, []));
        });
        editor.history = { undos: [], redos: [] };
      },
    }),
    [editor, focus],
  );

  // Açılınca imleç metnin sonunda (taslak ya da düzenlenen mesaj)
  useEffect(() => {
    if (!autoFocus) return;
    Transforms.select(editor, Editor.end(editor, []));
    ReactEditor.focus(editor);
    // Yalnızca açılışta
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Slate
      editor={editor}
      initialValue={initial}
      onChange={() => {
        const textChanged = editor.operations.some((op) => op.type !== 'set_selection');
        const caret = editor.selection ? toOffset(editor, editor.selection.focus) : textLength(editor);
        onChangeRef.current?.(editorText(editor), caret, textChanged);
      }}
    >
      <Content placeholder={placeholder} onKeyDown={onKeyDown} onPaste={onPaste} className={className} />
    </Slate>
  );
});

function Content({
  placeholder,
  onKeyDown,
  onPaste,
  className,
}: Pick<Props, 'placeholder' | 'onKeyDown' | 'onPaste' | 'className'>) {
  // useSlate: her değişiklikte yeniden çizilir, süslemeler güncel metinden hesaplanır
  const editor = useSlate();
  const lines = editor.children.map((n) => Node.string(n));
  const text = lines.join('\n');
  const ref = useRef<HTMLDivElement>(null);

  const { starts, segments, kinds } = useMemo(() => {
    const ls = text.split('\n');
    const starts = lineStarts(ls);
    const segments = markdownSegments(text);
    return { starts, segments, kinds: lineKinds(ls, starts, segments) };
  }, [text]);

  const decorate = useCallback(
    ([node, path]: NodeEntry): Range[] => {
      if (!Text.isText(node) || path.length !== 2 || path[1] !== 0) return [];
      const lineStart = starts[path[0]!];
      if (lineStart === undefined) return [];
      const lineEnd = lineStart + node.text.length;
      const ranges: Range[] = [];
      for (let i = firstSegment(segments, lineStart); i < segments.length; i++) {
        const s = segments[i]!;
        if (s.start >= lineEnd) break;
        if (s.marks.length === 0) continue;
        ranges.push({
          anchor: { path, offset: Math.max(s.start, lineStart) - lineStart },
          focus: { path, offset: Math.min(s.end, lineEnd) - lineStart },
          md: s.marks.join(' '),
        } as Range);
      }
      return ranges;
    },
    [starts, segments],
  );

  // Satırların blok görünümü; satır öğesi yeniden çizilmese de (ör. boş satır) güncel kalsın diye DOM'a yazılır
  useLayoutEffect(() => {
    const lines = ref.current?.querySelectorAll<HTMLElement>(':scope > [data-slate-node="element"]');
    lines?.forEach((el, i) => {
      const kind = kinds[i];
      if (kind) el.dataset.md = kind;
      else delete el.dataset.md;
    });
  });

  return (
    <Editable
      ref={ref}
      decorate={decorate}
      renderLeaf={Leaf}
      renderElement={Line}
      renderPlaceholder={Placeholder}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      // Dosya bırakılınca Slate metin eklemeye çalışmasın; dosyayı kanal görünümü ekler
      onDrop={(e) => e.dataTransfer.files.length > 0}
      spellCheck
      className={cn('break-words whitespace-pre-wrap outline-none', className)}
    />
  );
}
