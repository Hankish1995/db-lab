import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import plaintext from 'highlight.js/lib/languages/plaintext';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// Only the languages lessons use, instead of highlight.js's full default set (keeps the bundle small).
const LANGUAGES = { bash, javascript, js: javascript, json, plaintext, text: plaintext, sql, typescript, ts: typescript };

const components: Components = {
  // Links to other lessons (/lessons/…) navigate inside the app; external links open in a new tab.
  a: ({ href = '', children, node: _node, ...props }) =>
    href.startsWith('/') ? (
      <Link to={href} {...props}>
        {children}
      </Link>
    ) : (
      <a href={href} target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    ),
};

/**
 * Renders lesson and answer Markdown: GitHub tables, syntax-highlighted code,
 * and "> **Remember:** …" blockquotes styled as callouts.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-neutral dark:prose-invert max-w-none',
        'prose-headings:scroll-mt-20 prose-headings:font-semibold',
        'prose-a:text-primary prose-code:before:content-none prose-code:after:content-none',
        'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal',
        // `block` so plain-text blocks (not highlighted, so no .hljs styles) still get their padding.
        'prose-pre:bg-[#0d1117] prose-pre:p-0 [&_pre_code]:block [&_pre_code]:bg-transparent [&_pre_code]:p-4',
        // Tight line height + a font with full box-drawing glyphs keeps ASCII diagrams connected.
        "[&_pre]:leading-[1.25] [&_pre]:font-['Cascadia_Mono','Consolas','Menlo',monospace]",
        'prose-blockquote:not-italic prose-blockquote:rounded-r-lg prose-blockquote:border-l-4',
        'prose-blockquote:border-emerald-500 prose-blockquote:bg-emerald-500/10 prose-blockquote:py-1',
        'prose-blockquote:font-normal [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none',
        'prose-table:block prose-table:overflow-x-auto prose-th:text-left',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, languages: LANGUAGES, plainText: ['text'] }]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
