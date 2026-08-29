# TransLive brand spec · v0

## Assets

| Asset | Path | Use |
| --- | --- | --- |
| Primary mark | `assets/translive-brand/translive-mark.svg` | App icon、top bar、OAuth 畫面 |
| Tray raster | `assets/translive-brand/translive-tray.png` | Windows Tray、BrowserWindow icon |

## Mark concept

兩條方向相反的聲波共用中央節點：

- 白色上行聲波代表使用者送出的翻譯；
- 薄荷綠下行聲波代表使用者接收的翻譯；
- 藍色圓角底代表可信任的 Windows 工具；
- 不使用地球、旗幟或對話泡泡，避免將產品限制為特定語言或會議平台。

## Wordmark

- 文字：`TransLive`
- 字體：Segoe UI Variable Semibold
- 字距：正常，不全大寫
- 正式 UI 採 mark＋文字分離，避免 SVG 內嵌字體造成平台差異。

## Colors

| Token | Value |
| --- | --- |
| Brand blue | `#2F6FED` |
| Live mint | `#8CE1C7` |
| White | `#FFFFFF` |
| Monochrome dark | `#17191D` |

## Rules

- Mark 最小尺寸 20×20px；
- 四周保留至少 mark 寬度 20% 的空白；
- 不增加陰影、漸層、外框或旋轉；
- 單色環境可將兩條聲波與底色統一為黑／白；
- `translive-tray.png` 為 64px dev raster；
- 正式發布前仍應輸出多尺寸 ICO、PNG 與 Windows app tile 尺寸。
