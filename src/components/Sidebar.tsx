interface SidebarProps {
  visible: boolean;
}

export default function Sidebar({ visible }: SidebarProps) {
  return (
    <aside className={`sidebar ${visible ? "visible" : "hidden"}`}>
      <div className="sidebar-section">
        <h3>검색</h3>
        <input type="text" placeholder="제목 + 내용 검색" />
      </div>

      <div className="sidebar-section">
        <h3>폴더 트리</h3>
        <p>2단계 이후 구현 예정</p>
      </div>

      <div className="sidebar-section">
        <h3>태그</h3>
        <p>#태그 자동 인식 예정</p>
      </div>

      <div className="sidebar-section">
        <h3>메모 목록</h3>
        <p>필터/정렬 기능 예정</p>
      </div>
    </aside>
  );
}
