# dsh-roboexp

DeepSeek Harness 插件：让 agent 直接编写 [中鸣 RoboEXP（机器人快车）](https://www.zmrobo.com/) 的子程序模块与主程序，无需打开 GUI。

生成的模块（`.rcu` + `.c`）自动注册进 RoboEXP 模块库「AI 模块」分组，重启 GUI 即可见；主程序编译产出可烧录的 `.bin`。

## 前置条件

- Windows + 已安装 RoboEXP（默认探测 `%APPDATA%\RoboEXP`，可用配置 `roboDir` 或环境变量 `ROBOEXP_DIR` 覆盖）。
- .NET Framework 4.x（`ModuleFactory.exe` 依赖，Windows 自带）。

## 安装（用户）

前置条件：Windows + 已安装机器人快车（RoboEXP，默认自动探测 `%APPDATA%\RoboEXP`，可用配置 `roboDir` 或环境变量 `ROBOEXP_DIR` 覆盖）+ .NET Framework 4.x（Windows 自带）。

方式一（GitHub / Gitee 镜像）：
```sh
# GitHub
dsh plugin --profile desktop add github:mizengshuai/dsh-roboexp
# Gitee（国内访问更快；任意 git 托管都支持 git+https 完整地址）
dsh plugin --profile desktop add git+https://gitee.com/mizengshuai/dsh-roboexp.git
```

方式二（npm，发布后）：
```sh
dsh plugin --profile desktop add dsh-roboexp
```

方式三（本地目录 / 压缩包，免发布直接分发给朋友）：
```sh
dsh plugin --profile desktop add ./dsh-roboexp
# 或发给对方 dsh-roboexp-x.y.z.tgz（npm pack 产物），对方：
dsh plugin --profile desktop add ./dsh-roboexp-x.y.z.tgz
```
也可以在 DeepSeek Harness 桌面版：设置 → 插件 → 添加（填 GitHub 地址或本地路径）。

安装后重启 DeepSeek Harness 桌面版，会话中出现 14 个 `roboexp_*` 工具。

## WorkBuddy / CodeBuddy 技能版

同仓库 `workbuddy/roboexp/` 目录是同一能力的 WorkBuddy/CodeBuddy 技能封装（无需 DeepSeek Harness）：
```sh
git clone https://github.com/mizengshuai/dsh-roboexp.git
# WorkBuddy：把 workbuddy/roboexp 整个文件夹复制到 ~/.workbuddy/skills/ 下
xcopy /E /I dsh-roboexp\workbuddyoboexp "%USERPROFILE%\.workbuddy\skillsoboexp"
```
技能含 SKILL.md（工作流+命令手册+13 个现成预设 spec）、bin/ModuleFactory.exe、竞赛知识库与四份参考文档；agent 经终端直接调用，对话中提到巡线/子程序/机器人快车等关键词自动触发。

## 工具

| 工具 | 作用 |
|---|---|
| `roboexp_docs` | 指南 8 主题：workflow / modules / apps / apis / sensors / multitask / pid / icons（图标绘制：32×32 规范/配色/Pillow 模板） |
| `roboexp_kb` | **竞赛知识库（原创）**：5 个编译验证的参考模块（遇线停/巡线编码/差速转角/超声跟墙/紧巡线）+ 8 条调参经验 |
| `roboexp_icons` | 官方 system: 图标目录，供 icon 参数挑选 |
| `roboexp_list_presets` | 13 个现成模板（含编码器闭环走直线）（含走黑线 PD 循迹、超声避障） |
| `roboexp_add_preset` | **一键生成模块**：写入模块目录并编译验证，返回引用子程序操作指引 |
| `roboexp_controllers` | 全部 13 种主控实测能力（API 数/示例数/是否导出 Init） |
| `roboexp_examples` | 官方示例索引（分类/中文名/路径，可配合 module_info 阅读） |
| `roboexp_list_apis` | 按关键词查系统 API 表（签名/范围/中文说明/图标提示） |
| `roboexp_create_module` | 生成自定义模块（.rcu+.c），sysDeps 自动收集，icon 支持 `system:ApiName` |
| `roboexp_compile_module` | 全链接探针编译，抓 undefined reference |
| `roboexp_create_app` | 生成主程序（apps/ 子目录） |
| `roboexp_compile_app` | 编译主程序出 .bin |
| `roboexp_list_modules` | 列出已生成的模块/主程序母本（扫模块目录） |
| `roboexp_module_info` | 读任意 .rcu 的元数据与代码 |

## 模块使用方式（母本 + 手动引用）

- DSH 只负责**生成与验证**：模块母本写入 `<工作区>/roboexp_modules/`，不做任何全局注册，左侧工具箱不会出现 AI 分组。
- 用户在机器人快车里**手动引用**：打开项目 → 菜单「项目 → 引用子程序」（或子程序管理器 → 添加）→ 选择生成的 `.rcu`。项目开着即可引用，模块面板里以项目名命名的分组立即出现新积木，GUI 自动把模块文件复制进项目目录。
- 迭代：DSH 同名覆盖母本后，再次「引用子程序」选同一文件，同名提示时选"替换"。

## 配置（cordis.yml / 桌面版插件设置）

```yaml
- id: roboexp
  name: dsh-roboexp
  config:
    roboDir: ''        # RoboEXP 安装目录；空=自动
    softwareType: E7RCU # E7RCU / E3RCU / E6 / M6 …
    modulesDir: ''     # 输出目录；空=<工作区>/roboexp_modules
```

## 示例对话

- 「加一个前进模块」→ `roboexp_add_preset` 生成+编译验证，并告诉你引用步骤；你在机器人快车「项目 → 引用子程序」选 `Forward.rcu` 即可。
- 「加个鸣笛模块，默认响 3 次、速度 80」→ `roboexp_add_preset` + `paramDefaults`。
- 「做一个走黑线的模块」（自定义）→ agent 查 `roboexp_list_apis sensor` → `roboexp_create_module`（icon `system:GetInSensor`）→ `roboexp_compile_module` 验证。
- 「写个纯代码主程序：前进 2 秒、跳舞一次」→ `roboexp_create_app`（include `../MyMove.c`、`../MyDance.c`，`E7RCU_Init()` 开头）→ `roboexp_compile_app` 出 `apps/MainApp.bin`。（图形化项目的主程序在 GUI 里搭，AI 只提供子程序。）

## 实现说明

- `src/index.ts`：Cordis 插件，`defineTool` 注册工具；`bin/ModuleFactory.exe`（源码 `bin/ModuleFactory.cs`，x86/.NET 4）承担全部 RoboEXP 互操作：反序列化/序列化 .rcu（BinaryFormatter + RoboExp.exe 程序集反射）、写 UserInclude.xml、调 JMCompiler（arm-none-eabi-gcc）。
- 模块 .c 采用整文件幂等守卫（`#ifndef _NAME_` … `#endif`），嵌套 include 不重定义，且与 GUI 保存往返一致。
