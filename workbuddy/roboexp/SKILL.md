---
name: roboexp
description: |
  机器人快车（RoboEXP / 中鸣 ZMROBO）子程序模块与主程序的 AI 生成工具链：用本技能自带的
  ModuleFactory.exe 直接生成 .rcu/.c 模块、做全链接编译验证、查 API 表/主控清单/官方示例，
  用户再在机器人快车 GUI 里「项目 → 引用子程序」即可使用。

  Trigger scenarios — use when the user mentions any of:
  - 机器人快车, RoboEXP, 中鸣, ZMROBO, 子程序, 子程序模块, 竞赛程序
  - 巡线, 走黑线, 循迹, 遇线停, 锁线, 数路口, 压线停, 脱线停
  - 避障, 超声, 编码器, 走直线, 差速, 转角度, 麦轮, 寻迹卡
  - E7RCU, E6RCU, E3RCU, M6RCU, C6RCU, 控制器, 主控
  - 生成模块, 做一个XX模块, 写子程序, 编译 .bin, 图标

  前置条件：Windows + 已安装机器人快车（自动探测 %APPDATA%\RoboEXP；装在别处设 ROBOEXP_DIR
  环境变量）+ .NET Framework 4.x（Windows 自带）。
---

# RoboEXP（机器人快车）子程序生成技能

## 你（agent）的工作方式

本技能的核心是自带工具 `bin/ModuleFactory.exe`（x86 .NET 命令行工具，本目录相对路径执行）。
你用终端直接调用它完成一切；用户在机器人快车 GUI 里用「项目 → 引用子程序」把生成的模块加进项目。

设 `%SKILL%` = 本技能目录。所有命令示例中用它代替实际路径。

## 标准工作流

1. **明确需求**：功能匹配现成模板（见 `presets/`，13 个）→ 直接用模板 spec；否则查 API 表自定义。
   查 API：`%SKILL%\bin\ModuleFactory.exe apis E7RCU <关键词>`（返回 JSON：签名/参数范围/中文说明/icon 提示）
2. **生成模块**：写 spec.json（格式见下）→ `%SKILL%\bin\ModuleFactory.exe module <spec.json>`
   输出到 `<工作目录>/roboexp_modules/`（spec 的 outDir 决定）。
3. **必须验证**：`%SKILL%\bin\ModuleFactory.exe compilestrict <模块.c> E7RCU`
   返回 {"ok":true/false,"log":...}。ok:false 时按 log 里的 file:line 错误修改 code 后重新生成再验。
4. **告诉用户**：模块已生成并验证，给出路径和操作步骤——
   「机器人快车：打开你的项目 → 菜单 项目→引用子程序（或子程序管理器→添加）→ 选择 <模块.rcu 路径>。
   项目开着即可引用，模块面板的项目分组立即出现新积木。」

## module 命令的 spec.json 格式

```json
{
  "name": "MyModule",            // 必填：ASCII C 标识符，不能与系统模块重名
  "caption": "我的模块",           // GUI 显示名
  "description": "功能说明",
  "softwareType": "E7RCU",       // 控制器类型，见 controllers 命令
  "outDir": "C:/输出目录",         // 模块 .rcu/.c 生成位置
  "icon": "system:SetMotor",     // 见「图标」节
  "register": "false",           // 保持 false：不做全局注册，用户手动引用
  "params": [
    {"name": "speed", "type": "int", "default": "60", "min": "10", "max": "100", "desc": "速度"}
  ],
  "sysDeps": [],                 // 留空：自动扫描代码收集用到的系统 API
  "userDeps": [],                // 依赖的其它自建模块名（同目录须已存在）
  "code": "{\n    SetMotor(_M1_, speed);\n}"   // 只写函数体！花括号可省略
}
```

## 铁律（违反必出错）

1. **code 只写函数体**：不写函数签名、#include、宏守卫——全部自动生成（含 JMLib 条件块与幂等守卫）。
2. **C90 方言**：变量声明放块首；`static` 可用于跨调用状态。
3. **硬件端口参数**：GUI 类型用 `_PORT_`/`_MOTOR_`（GUI 显示端口选择器），但 C 代码里它们是
   `uint8_t` 值（`_P1_`..`_P8_`=1..8、`_M1_`..`_M8_`=1..8，数字可直接传 API）。
4. **编号语义**：判定传感器用编号直接指定——分立光电=端口号 1-8，寻迹卡=通道号 1-7
   （GetTraceV2I2C(口,通道) 读相对光值、(口,10+通道) 读参考值）。禁止 2=左/4=右 之类抽象编码。
5. **路口计数必须边沿判别**：记住上次状态，状态翻转时才 +1。
6. **GetUltrasound 返回 4..180cm**；888=超范围、999=出错——比较前必须过滤
   （`if (d >= 4 && d <= 180)`）。
7. **主程序 main 开头是否调 `<主控>_Init()` 查 controllers 命令的 initFuncName**：
   E7/E6/M6/C6/C1 有，E3/X3/X4/E2/M 系没有（没有就不要调）。main 末尾 `while(1);`。
8. **创建模块后必须 compilestrict**：func 语法检查抓不住拼错的 API（隐式声明），全链接探针才能抓
   undefined reference。
9. 图形化项目的主程序由用户在 GUI 搭积木，AI 只提供子程序模块。

## 常用命令速查

```
%SKILL%\bin\ModuleFactory.exe apis E7RCU <关键词>       # 查 API 表（JSON）
%SKILL%\bin\ModuleFactory.exe controllers               # 13 种主控：API 数/示例数/Init 有无
%SKILL%\bin\ModuleFactory.exe examples E7RCU <关键词>    # 官方示例索引（分类/中文名/路径）
%SKILL%\bin\ModuleFactory.exe info <任意.rcu>            # 读元数据：参数/依赖/代码（含官方模块）
%SKILL%\bin\ModuleFactory.exe module <spec.json>         # 生成模块（JSON 结果）
%SKILL%\bin\ModuleFactory.exe compilestrict <模块.c> E7RCU   # 全链接验证（JSON 判定）
%SKILL%\bin\ModuleFactory.exe compile <主程序.c> main E7RCU # 编译主程序出 .bin
%SKILL%\bin\ModuleFactory.exe sysicons E7RCU <关键词>    # 可用的 system: 图标名单
```

环境变量 `ROBOEXP_DIR` 可指定机器人快车安装目录（默认 %APPDATA%\RoboEXP 自动探测）。

## 预设模板（presets/ 目录，复制改参数即用）

forward 前进 | backward 后退 | spin_left/right 原地转 | stop 停车 | beep_times 鸣笛N次 |
beep_seconds 长鸣 | dance 欢乐舞 | wait 等待 | walk_square 走正方形 |
**line_follow 走黑线**（双光电 PD+丢线找回） | **obstacle_avoid 超声避障** |
**go_encoder 编码走直线**（双轮编码差纠偏；标准高速马达一圈=780 编码，异型≈1080）

用预设：复制 presets/<名>.spec.json 到工作目录，改 name/outDir（和想覆盖的 default），跑 module 命令。

## 图标

- 首选 `system:ApiName`（复用官方照片风格图标，sysicons 命令查名单，apis 返回每条也带 icon 提示）
- 自绘：32×32 PNG（必须 32×32、不透明满幅）→ spec 的 icon 填 PNG 绝对路径。
  完整规范+配色+Pillow 代码模板见 references/icons.md（128×128 超采样→LANCZOS 缩到 32×32）

## 深入参考（按需阅读）

- references/module-rules.md — 模块编写规则详解、主程序(CodeApp)写法、多任务结论
- references/sensors.md — 传感器/输入 API 速查（光电/超声/触碰/计时/音乐/显示）
- references/competition.md — 竞赛调参经验（光电配置六模式、锁线力度×速度、前冲标定、故障速查）
- kb/modules.json — 6 个竞赛模式参考实现（遇线停/巡线编码/差速转角/超声跟墙/紧巡线/寻迹卡遇线停，含完整代码）
- kb/experience.json — 8 条调参经验条目

## 主程序（仅当用户要纯代码主程序时）

app spec 同上但 code 为完整编译单元：顶部 `#include "../<模块名>.c"`（模块在 app 上一级目录）、
`int main(void){ <主控>_Init(); ...; while(1); }`。outDir 用 `<模块目录>/apps`。
生成后 `%SKILL%\bin\ModuleFactory.exe compile <app.c> main E7RCU` 出 .bin。
