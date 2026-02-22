export default function SearchBar() {
  return (
    <div className="searchbar">
      <input type="text" placeholder="Ctrl+F 현재 문서 검색 (2단계에서 고도화)" />
      <button type="button">찾기</button>
    </div>
  );
}
