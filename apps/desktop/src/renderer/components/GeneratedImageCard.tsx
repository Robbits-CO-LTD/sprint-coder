import { useEffect, useState } from 'react';
import type { GeneratedImage } from '../types/sprint-coder';

// Displays an image a Runtime generated (issue #11).
//
// Markdown.tsx's `SafeImage` refuses to put any `src` in the DOM at all — assistant Markdown is
// attacker-influenceable, so an <img src> there would be a DOM-based exfiltration channel (the URL,
// and therefore its query string, would be chosen by the model). That rule is not relaxed here.
// Instead this is a separate path with a different trust basis:
//
//   - the bytes come from a directory the CLI owns, located by a structured thread id rather than by
//     any path the model wrote (see main/generated-image-collector.ts);
//   - Main verified the PNG magic bytes before storing them;
//   - the renderer receives base64 over IPC and builds a `data:` URL, so displaying an image can
//     neither read the filesystem nor issue a network request.
//
// A `data:` URL is what makes that last property hold. Handing the renderer a `file://` path would
// re-introduce exactly the class of bug SafeImage exists to prevent.

type LoadState =
  { status: 'loading' } | { status: 'ready'; dataUrl: string } | { status: 'failed' };

export function GeneratedImageCard({ image }: { image: GeneratedImage }) {
  // Capability check at render time, not inside the effect: a backend without the images API needs
  // no fetch at all, and deciding it here keeps the effect free of a synchronous setState.
  const supported = typeof window.sprintCoder?.images?.read === 'function';
  const [state, setState] = useState<LoadState>(
    supported ? { status: 'loading' } : { status: 'failed' },
  );

  useEffect(() => {
    const read = window.sprintCoder?.images?.read;
    if (typeof read !== 'function') return;
    let cancelled = false;
    void read(image.id)
      .then((bytes) => {
        if (cancelled) return;
        setState({ status: 'ready', dataUrl: `data:${bytes.mimeType};base64,${bytes.base64}` });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [image.id, supported]);

  return (
    <figure className="genimg-card" data-testid="generated-image-card" data-image-id={image.id}>
      {state.status === 'ready' ? (
        <img
          className="genimg"
          data-testid="generated-image"
          src={state.dataUrl}
          // The model never supplies this text — it would be untrusted content in the accessible
          // name. What is true and known is that this is a generated image and how large it is.
          alt="生成された画像"
        />
      ) : (
        <div className="genimg-placeholder" data-testid="generated-image-placeholder">
          {state.status === 'loading' ? '画像を読み込んでいます…' : '画像を読み込めませんでした'}
        </div>
      )}
      <figcaption className="genimg-caption">
        生成された画像 · {formatBytes(image.byteLength)}
      </figcaption>
    </figure>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shown when a Turn asked for an image and none arrived.
 *
 * The issue is explicit that this must not read as success: Codex has been reported to finish a turn
 * without ever calling the image tool, and the CLI does not distinguish that from "tool ran". Since
 * the only evidence of a real image is a file the app took custody of, absence is the signal.
 */
export function MissingGeneratedImageNotice() {
  return (
    <div className="genimg-missing" data-testid="generated-image-missing" role="note">
      画像生成を依頼しましたが、生成された画像を受け取れませんでした。Codexが画像ツールを呼ばずに応答した可能性があります。
    </div>
  );
}
