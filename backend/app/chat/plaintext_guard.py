class PlaintextStorageForbidden(Exception):
    """加密房间的正文不能写入 Hub。"""

    def __init__(self, room_id: str):
        self.room_id = room_id
        super().__init__(room_id)
