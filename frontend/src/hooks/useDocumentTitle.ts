import { useEffect } from "react";

const FALLBACK_TITLE = "Parlor";

export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title.trim() || FALLBACK_TITLE;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
