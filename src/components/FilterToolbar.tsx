interface Props {
  searchFilter: string;
  onSearchChange: (value: string) => void;
}

export function FilterToolbar({
  searchFilter,
  onSearchChange,
}: Props) {
  return (
    <div className="filter-toolbar">
      <div className="filter-search-wrap">
        <input
          type="text"
          placeholder="Search processes..."
          value={searchFilter}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchFilter.length > 0 && (
          <button
            type="button"
            className="filter-search-clear"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => onSearchChange("")}
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );
}
