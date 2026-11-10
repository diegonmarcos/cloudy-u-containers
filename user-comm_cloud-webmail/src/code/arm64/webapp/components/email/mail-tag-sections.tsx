"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { TagBadge, type TagBadgeVariant, TAG_GROUP_CLASS } from "./tag-badge";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { classifyTagIds } from "@/lib/keyword-classification";

/**
 * The two tag families in the reading panel (#1590).
 *
 * Tags split by their display name into "Project" (`1*`-`9*`) and "Meta"
 * (`A*`-`Z*`); anything that matches neither rides along with Project so no tag
 * ever disappears. Project is the day-to-day grouping, so its section is a
 * collapsible that starts open; Meta is reference detail, so its section starts
 * collapsed behind a "see more". Each is drawn only when it holds tags.
 *
 * The label resolver and the split both come from the shared keyword helpers,
 * so a tag reads and sorts here exactly as it does elsewhere in the client.
 */
export function MailTagSections({
  tagIds,
  variant = "badge",
  onRemove,
  className,
}: {
  tagIds: string[];
  variant?: TagBadgeVariant;
  /** Takes a tag off the message; omit to render read-only. */
  onRemove?: (tagId: string) => void;
  className?: string;
}) {
  const t = useTranslations("email_viewer");
  const { tagName } = useKeywordFormat();
  const [projectOpen, setProjectOpen] = useState(true);
  const [metaOpen, setMetaOpen] = useState(false);

  const { projectTags, metaTags } = useMemo(() => {
    const { meta, project, other } = classifyTagIds(tagIds, tagName);
    return { projectTags: [...project, ...other], metaTags: meta };
  }, [tagIds, tagName]);

  if (projectTags.length === 0 && metaTags.length === 0) return null;

  const renderBadges = (ids: string[]) =>
    ids.map((tagId) => (
      <TagBadge
        key={tagId}
        tagId={tagId}
        variant={variant}
        onRemove={onRemove ? () => onRemove(tagId) : undefined}
      />
    ));

  return (
    <div className={cn("mt-1.5 flex flex-col gap-1.5", className)}>
      {projectTags.length > 0 && (
        <div className="flex items-start gap-1.5">
          <button
            type="button"
            onClick={() => setProjectOpen((v) => !v)}
            aria-expanded={projectOpen}
            className="flex shrink-0 items-center gap-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors pt-0.5"
          >
            {projectOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {t("project_tags")}
            {!projectOpen && (
              <span className="ms-0.5 text-muted-foreground/70">
                ({projectTags.length})
              </span>
            )}
          </button>
          {projectOpen && (
            <div className={cn(TAG_GROUP_CLASS, "flex-wrap")}>
              {renderBadges(projectTags)}
            </div>
          )}
        </div>
      )}

      {metaTags.length > 0 && (
        <div className="flex items-start gap-1.5">
          <button
            type="button"
            onClick={() => setMetaOpen((v) => !v)}
            aria-expanded={metaOpen}
            className="flex shrink-0 items-center gap-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors pt-0.5"
          >
            {metaOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {t("meta_tags")}
            {!metaOpen && (
              <span className="ms-0.5 text-muted-foreground/70">
                ({metaTags.length})
              </span>
            )}
          </button>
          {metaOpen ? (
            <div className={cn(TAG_GROUP_CLASS, "flex-wrap")}>
              {renderBadges(metaTags)}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setMetaOpen(true)}
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline pt-0.5"
            >
              {t("see_more")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
