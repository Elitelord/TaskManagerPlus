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
      <input
        type="text"
        placeholder="Search processes..."
        value={searchFilter}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  );
}
