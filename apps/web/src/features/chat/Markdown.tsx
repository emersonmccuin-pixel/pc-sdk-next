// Project-wide markdown renderer. Wraps ReactMarkdown with the canonical plugin
// set (gfm + breaks) and the shared `.markdown-body` styles from index.css.
// Fenced ```mermaid blocks route through MermaidBlock.

import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { mermaidCodeOverride } from './MermaidBlock';

const COMPONENTS = { code: mermaidCodeOverride };

interface MarkdownProps {
  text: string;
  className?: string;
}

export function Markdown({ text, className }: MarkdownProps) {
  const cls = className ? `markdown-body ${className}` : 'markdown-body';
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
