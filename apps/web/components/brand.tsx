import { PanelsTopLeft } from 'lucide-react';
import Link from 'next/link';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="Commonplace home">
      <span className="brand-mark">
        <PanelsTopLeft size={19} strokeWidth={1.8} />
      </span>
      {!compact && (
        <span>
          commonplace<span className="brand-dot">.</span>
        </span>
      )}
    </Link>
  );
}
