import { formatUiEvidenceMarkdown } from '@studio/contracts';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './MarkdownDocument.module.css';

export function MarkdownDocument({ text }: { text: string }) {
  return (
    <>
      <article
        data-markdown-body=""
        aria-label="문서 본문"
        className={styles.body}
      >
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            table: ({ children }) => (
              <div
                className={styles.tableScroll}
                tabIndex={0}
                role="region"
                aria-label="문서 표"
              >
                <table>{children}</table>
              </div>
            ),
            img: ({ alt }) => <span>{alt || '이미지'}</span>,
            a: ({ href, children }) =>
              href && /^(https?:\/\/|mailto:)/i.test(href) ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
          }}
        >
          {formatUiEvidenceMarkdown(text)}
        </Markdown>
      </article>
      <details className={styles.source}>
        <summary>원문 보기</summary>
        <pre data-markdown-source="">{text}</pre>
      </details>
    </>
  );
}
