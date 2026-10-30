'use client';

import * as React from 'react';
import { FileText, ImageIcon, UploadCloud, X } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';

export interface PendingFile {
  id: string;
  file: File;
}

/** Controlled dropzone: the parent owns the file list and uploads it after the project exists. */
export function FileUploadDropzone({
  files,
  onChange,
  accept,
  maxMb = 15,
  label,
  hint,
  multiple = true,
  className,
}: {
  files: PendingFile[];
  onChange: (files: PendingFile[]) => void;
  accept?: string;
  maxMb?: number;
  label: string;
  hint?: string;
  multiple?: boolean;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function add(list: FileList | null) {
    if (!list) return;
    setError(null);
    const next: PendingFile[] = [];
    for (const file of Array.from(list)) {
      if (file.size > maxMb * 1024 * 1024) {
        setError(`${file.name} is larger than ${maxMb} MB`);
        continue;
      }
      next.push({ id: `${file.name}-${file.size}-${file.lastModified}`, file });
    }
    const merged = multiple ? [...files, ...next] : next.slice(0, 1);
    onChange(merged.filter((f, i, arr) => arr.findIndex((x) => x.id === f.id) === i));
  }

  return (
    <div className={className}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-7 text-center transition-colors',
          over ? 'border-accent bg-accent-soft/50' : 'border-cream-300 bg-cream-50 hover:border-ink-600/40',
        )}
      >
        <UploadCloud className="mb-2 h-6 w-6 text-accent" />
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{hint ?? `Drag & drop or click to browse. Up to ${maxMb} MB each.`}</p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={accept}
          multiple={multiple}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-xl border border-cream-300/80 bg-cream-50 px-3 py-2 text-sm"
            >
              {f.file.type.startsWith('image/') ? (
                <ImageIcon className="h-4 w-4 text-muted" />
              ) : (
                <FileText className="h-4 w-4 text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate">{f.file.name}</span>
              <span className="text-xs text-muted">{formatBytes(f.file.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.file.name}`}
                onClick={() => onChange(files.filter((x) => x.id !== f.id))}
                className="rounded-md p-1 text-muted hover:bg-cream-200 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
