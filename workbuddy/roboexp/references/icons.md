# 模块图标绘制指南（32×32 PNG）

## 硬性要求
- **32×32 像素 PNG**：机器人快车全部 242 个官方图标均为 32×32，GUI 面板按 32×32 显示（ImageList 固定），其它尺寸会被拉伸变形。
- **不透明、填满画布**：官方与竞赛图标均无透明背景（0% 透明像素），圆角方块底色铺满。
- 保存到工作区后把**绝对路径**传给 create_module / add_preset 的 icon 参数（第三种 icon 取值，除 system: 与 PNG 路径外无其它格式）。
- 选型顺序：功能有对应官方图标 → system:ApiName；要差异化 → 本指南自绘；两者都不便 → 留空由插件画字母块。

## 视觉语言规律（竞赛图标实证分析）
- **底色即分类**：动作/运动类 = 橙黄底 #F0C020（覆盖率约 50%）；传感/输入类 = 浅蓝底 #C0E0F0 或 #70C0F0；工具/辅助类 = 灰白底。
- **元素语义**（32px 内最多 2-3 个元素，宁大勿小）：
  | 功能 | 画法 |
  |---|---|
  | 巡线 | 竖黑线 + 蓝箭头沿线向上 |
  | 紧巡线 | 波浪黑线 + 蓝箭头 |
  | 遇线停 | 横黑线 + 箭头止于线上（可加红 STOP 感元素） |
  | 穿线/越线 | 横黑线 + 双向或贯穿箭头 |
  | 锁线 | 横黑线 + 手指/夹钳抓线图形 |
  | 转向 | 弯曲箭头，方向即转向方向 |
  | 定角转 | 罗盘/三角指针 + 角度弧 |
  | 测距 | 传感器小方块 + 扩散弧线 + 尺子或 cm 字样 |
  | 编码器 | 圆轮 + 刻度/数字 |
  | 声音 | 喇叭 + 弧线 |
  | 颜色 | 并排彩色竖条 |

## 推荐配色
底色：动作橙黄 #F0C020｜传感浅蓝 #C0E0F0｜官方蓝 #70C0F0
线条/描边：近黑 #101010｜高光/留白：#F0F0F0
箭头/方向：蓝 #2050C0｜停止/警示：红 #F03030｜测量/声波：黄 #F0F000｜确认/完成：绿 #30A030

## Pillow 代码模板（DSH 运行时自带 Python+Pillow，可直接执行）
关键技巧：**先画 128×128 再缩到 32×32**（LANCZOS），直接画 32px 会锯齿严重。

    from PIL import Image, ImageDraw

    BG_ACTION, BG_SENSE = (240, 192, 32), (192, 224, 240)
    INK, ARROW = (16, 16, 16), (32, 80, 192)

    def finish(im):
        return im.resize((32, 32), Image.LANCZOS)

    # 例1：巡线（竖黑线+蓝箭头）
    im = Image.new('RGB', (128, 128), BG_ACTION); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 127, 127], outline=INK, width=4)
    d.rectangle([56, 0, 72, 127], fill=INK)                    # 轨迹线
    d.polygon([(48, 96), (80, 96), (64, 40)], fill=ARROW)      # 向上箭头
    finish(im).save('icon_linefollow.png')

    # 例2：遇线停（横线+止步箭头+红点）
    im = Image.new('RGB', (128, 128), BG_ACTION); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 127, 127], outline=INK, width=4)
    d.rectangle([16, 40, 112, 56], fill=INK)                   # 横轨迹线
    d.polygon([(40, 112), (88, 112), (64, 68)], fill=ARROW)    # 箭头指向线
    d.ellipse([56, 22, 72, 38], fill=(240, 48, 48))            # 红色停点
    finish(im).save('icon_catchline.png')

    # 例3：超声测距（传感蓝底+传感器块+声波弧）
    im = Image.new('RGB', (128, 128), BG_SENSE); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 127, 127], outline=INK, width=4)
    d.rectangle([20, 48, 52, 80], fill=INK)                    # 传感器
    for i, r in enumerate((34, 52, 70)):
        d.arc([52 - r, 64 - r, 52 + r, 64 + r], -60, 60, fill=(240, 240, 0), width=5)  # 声波
    finish(im).save('icon_ultra.png')

风格要点：黑色描边框住整个图标、元素大而少、高饱和纯色、不用渐变与阴影（32px 下会糊成噪点）。
