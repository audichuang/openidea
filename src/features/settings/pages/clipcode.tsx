/**
 * Settings › Version Control › ClipCode: what a ClipCode copy puts on the clipboard.
 * The options and their words are the ClipCode IntelliJ plugin's (its VS Code twin
 * shares the keys), so a payload copied here restores in either and vice versa.
 */
import { tx } from "@/platform/i18n";
import { WORKFLOW_LIMITS, type ClipFilterRuleValid } from "@/platform/workflowSettings";
import { Button, Checkbox, IconButton, Input, Select, T } from "@/ui";
import { Row } from "../components/Form";
import { useSetting } from "../components/context";
import type { PageSpec } from "./spec";
import { ToggleNumber } from "./workflowControls";
import styles from "./ClipCode.module.css";

const TYPES = [
  { value: "PATH", label: "Path" },
  { value: "PATTERN", label: "Pattern" },
] as const;
const ACTIONS = [
  { value: "INCLUDE", label: "Include" },
  { value: "EXCLUDE", label: "Exclude" },
] as const;

/** The filter rules table with the plugin's four Add buttons. */
function FilterRules() {
  const [rules, setRules] = useSetting<ClipFilterRuleValid[]>("vcs.clipCode.filterRules");
  const update = (i: number, patch: Partial<ClipFilterRuleValid>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (type: ClipFilterRuleValid["type"], action: ClipFilterRuleValid["action"]) =>
    setRules([...rules, { type, action, value: "", enabled: true }]);
  return (
    <Row
      label="Filter rules"
      stacked
      hint="Path rules match the path or a folder above it; pattern rules match the file name (* and ? wildcards, otherwise a regular expression)."
    >
      <div className={styles.rules} role="table" aria-label={tx("Filter rules")}>
        {rules.length === 0 && (
          <div className={styles.empty}>
            <T>No filter rules</T>
          </div>
        )}
        {rules.map((r, i) => (
          <div key={i} className={styles.rule} role="row">
            <Checkbox checked={r.enabled} onChange={(v) => update(i, { enabled: v })} aria-label={tx("Enabled")} />
            <Select
              aria-label="Type"
              value={r.type}
              onChange={(type) => update(i, { type })}
              options={TYPES.map((t) => ({ value: t.value, label: tx(t.label) }))}
            />
            <Select
              aria-label="Action"
              value={r.action}
              onChange={(action) => update(i, { action })}
              options={ACTIONS.map((a) => ({ value: a.value, label: tx(a.label) }))}
            />
            <Input
              className={styles.value}
              value={r.value}
              placeholder={r.type === "PATH" ? "src/generated" : "*.min.js"}
              onChange={(e) => update(i, { value: e.target.value })}
              aria-label={tx("Filter")}
            />
            <IconButton
              icon="close"
              size="small"
              title="Remove"
              onClick={() => setRules(rules.filter((_, j) => j !== i))}
            />
          </div>
        ))}
      </div>
      <div className={styles.buttons}>
        <Button size="small" onClick={() => add("PATH", "INCLUDE")}>
          <T>Include Path/File</T>
        </Button>
        <Button size="small" onClick={() => add("PATH", "EXCLUDE")}>
          <T>Exclude Path/File</T>
        </Button>
        <Button size="small" onClick={() => add("PATTERN", "INCLUDE")}>
          <T>Include Pattern</T>
        </Button>
        <Button size="small" onClick={() => add("PATTERN", "EXCLUDE")}>
          <T>Exclude Pattern</T>
        </Button>
      </div>
    </Row>
  );
}

function FileCount() {
  return (
    <ToggleNumber
      toggleKey="vcs.clipCode.setMaxFileCount"
      numberKey="vcs.clipCode.fileCountLimit"
      label="Set maximum number of files to have their content copied"
      min={WORKFLOW_LIMITS.clipFileCount.min}
      max={WORKFLOW_LIMITS.clipFileCount.max}
      hint="Copying many files may cause high memory usage."
    />
  );
}

export const CLIPCODE_PAGE: PageSpec = {
  id: "vcs.clipcode",
  title: "ClipCode",
  order: 9,
  projectScope: true,
  keywords: ["clipboard", "copy", "paste", "snip-sync", "clipcode", "restore"],
  sections: [
    {
      title: "Text structure of what's going to the clipboard",
      options: [
        {
          kind: "text",
          key: "vcs.clipCode.headerFormat",
          label: "File header format",
          placeholder: "// file: $FILE_PATH",
          hint: "$FILE_PATH is replaced with the file's path.",
        },
        { kind: "text", key: "vcs.clipCode.preText", label: "Pre text" },
        { kind: "text", key: "vcs.clipCode.postText", label: "Post text" },
        { kind: "toggle", key: "vcs.clipCode.addExtraLineBetweenFiles", label: "Add an extra line between files" },
      ],
    },
    {
      title: "Constraints for copying",
      options: [
        { kind: "custom", label: "Set maximum number of files to have their content copied", component: FileCount },
        {
          kind: "number",
          key: "vcs.clipCode.maxFileSizeKB",
          label: "Maximum file size",
          unit: "KB",
          integer: true,
          min: WORKFLOW_LIMITS.clipFileSizeKb.min,
          max: WORKFLOW_LIMITS.clipFileSizeKb.max,
          hint: "Larger files are copied as a placeholder that is never restored.",
        },
      ],
    },
    {
      title: "Information on what has been copied",
      options: [{ kind: "toggle", key: "vcs.clipCode.showCopyNotification", label: "Show notification after copying" }],
    },
    {
      title: "Filters",
      options: [
        { kind: "toggle", key: "vcs.clipCode.useFilters", label: "Enable filtering" },
        { kind: "toggle", key: "vcs.clipCode.useIncludeFilters", label: "Enable include rules" },
        { kind: "toggle", key: "vcs.clipCode.useExcludeFilters", label: "Enable exclude rules" },
        {
          kind: "custom",
          label: "Filter rules",
          keywords: ["Include Path/File", "Exclude Path/File", "Include Pattern", "Exclude Pattern"],
          component: FilterRules,
        },
      ],
    },
  ],
};
