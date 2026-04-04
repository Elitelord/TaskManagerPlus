import type { DisplayMode } from "../App";

interface Props {
  searchFilter: string;
  onSearchChange: (value: string) => void;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
}

export function FilterToolbar({
  searchFilter,
  onSearchChange,
  displayMode,
  onDisplayModeChange,
}: Props) {
  return (
    <div className="filter-toolbar">
      <input
        type="text"
        placeholder="Search processes..."
        value={searchFilter}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <div className="display-mode-toggle">
        <button 
          className={displayMode === "percent" ? "active" : ""} 
          onClick={() => onDisplayModeChange("percent")}
        >
          %
        </button>
        <button 
          className={displayMode === "values" ? "active" : ""} 
          onClick={() => onDisplayModeChange("values")}
        >
          Values
        </button>
      </div>
    </div>
  );
}
