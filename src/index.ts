// dsh-roboexp — DeepSeek Harness plugin that lets the agent author RoboEXP
// (中鸣 机器人快车) subroutine modules and main programs without the GUI.
//
// All RoboEXP interaction goes through the bundled x86 .NET tool bin/ModuleFactory.exe
// (source: bin/ModuleFactory.cs): it generates .rcu + .c pairs, registers modules in
// UserInclude.xml, and drives JMCompiler for syntax-check / full-link / app compiles.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-roboexp'
export const inject = ['tools']

export interface Config {
  roboDir: string
  softwareType: string
  modulesDir: string
}

export const Config: Schema<Config> = Schema.object({
  roboDir: Schema.string().default('').description(
    'RoboEXP 安装目录（含 RoboExp.exe）；留空 = 自动检测（ROBOEXP_DIR 环境变量 / %APPDATA%\\RoboEXP）'),
  softwareType: Schema.string().default('E7RCU').description(
    '默认控制器类型：E7RCU / E3RCU / E6 / M6 …（对应 Robots\\<类型> 目录）'),
  modulesDir: Schema.string().default('').description(
    '模块与主程序输出目录；留空 = <会话工作区>/roboexp_modules'),
})

const here = path.dirname(fileURLToPath(import.meta.url))
const factoryExe = path.resolve(here, '..', 'bin', 'ModuleFactory.exe')
const kbDir = path.resolve(here, '..', 'kb')
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const LOG_CAP = 50_000

// ---------------------------------------------------------------- competition knowledge base
// Original content only: our own reference modules (compile-verified) and our own tuning
// notes. No third-party platform code, icons, names or texts are bundled.

let kbCache: any = null
function loadKb(): any {
  if (kbCache) return kbCache
  try {
    kbCache = {
      modules: JSON.parse(fs.readFileSync(path.join(kbDir, 'modules.json'), 'utf8')).modules,
      experience: JSON.parse(fs.readFileSync(path.join(kbDir, 'experience.json'), 'utf8')).entries,
    }
  } catch {
    kbCache = { modules: [], experience: [] }
  }
  return kbCache
}

// ---------------------------------------------------------------- factory runner

interface FactoryResult { code: number, stdout: string, stderr: string }

function runFactory(args: string[], opts: {
  roboDir?: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<FactoryResult> {
  if (!fs.existsSync(factoryExe)) {
    return Promise.reject(new Error(`ModuleFactory.exe not found at ${factoryExe} — the plugin install is incomplete`))
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (opts.roboDir) env.ROBOEXP_DIR = opts.roboDir
    const child = spawn(factoryExe, args, { cwd: opts.cwd, env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => { if (!settled) { settled = true; cleanup(); fn() } }
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null
    const onAbort = () => child.kill()
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })))
  })
}

/** ModuleFactory prints compiler chatter first, then one JSON line. Return that line. */
function parseLastJson(stdout: string): any | undefined {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim()
    if (l.startsWith('{') || l.startsWith('[')) {
      try { return JSON.parse(l) } catch { /* keep walking up */ }
    }
  }
  return undefined
}

const capLog = (s: string) => (s.length > LOG_CAP ? '…' + s.slice(-LOG_CAP) : s)

function sessionCwd(exec: any): string {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

interface Runtime {
  roboDir: string
  softwareType: string
  modulesDir: string
}

function resolveRuntime(config: Config, exec: any, softwareType?: string): Runtime {
  const cwd = sessionCwd(exec)
  let modulesDir = config.modulesDir.trim()
  if (!modulesDir) modulesDir = path.join(cwd, 'roboexp_modules')
  if (!path.isAbsolute(modulesDir)) modulesDir = path.resolve(cwd, modulesDir)
  fs.mkdirSync(modulesDir, { recursive: true })
  return {
    roboDir: config.roboDir.trim(),
    softwareType: softwareType?.trim() || config.softwareType,
    modulesDir,
  }
}

const jsonRender = (_args: unknown, value: unknown): { type: 'text', text: string }[] =>
  [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// ---------------------------------------------------------------- embedded guides

const GUIDES: Record<string, string> = {
  workflow: `# RoboEXP 开发工作流

1. **生成**：说需求即可。匹配现成模板（前进/鸣笛等）→ roboexp_add_preset 一键生成；不匹配 → roboexp_create_module 自定义（先 roboexp_list_apis 查 API）。
   模块母本生成到 <工作区>/roboexp_modules/，生成后立即全链接编译验证（roboexp_compile_module / 自动）。
2. **使用（用户在机器人快车里手动做）**：打开项目 → 菜单「项目 → 引用子程序」（或子程序管理器 → 添加）→ 选择生成的 <模块名>.rcu。
   项目**开着就能引用**，模块面板里以项目名命名的分组立即出现新积木；GUI 会自动把模块文件复制进项目目录。
   完成后把该路径和操作步骤明确告诉用户。
3. **迭代**：用户要改模块 → 同名重新生成（覆盖 roboexp_modules 里的母本）→ 提示用户再次「引用子程序」选同一文件，同名提示时选"替换"。
4. 主程序：图形化项目由用户在 GUI 搭积木并下载（AI 只提供子程序）；纯 AI 代码主程序用 roboexp_create_app / roboexp_compile_app。

编译失败时 log 里有 arm-none-eabi-gcc 的 file:line 错误，据此修改后重新创建同名模块（会覆盖旧文件）。`,

  modules: `# 子程序模块（CodeFunc）编写规则

模块 = 一个 C 子函数。母本保存在 <工作区>/roboexp_modules/；用户在 GUI 通过「项目 → 引用子程序」把模块加进自己的项目（自动复制进项目目录、项目分组即时出现）。不做全局模块库注册。

- name：ASCII C 标识符，不能与系统模块重名。
- code：**只写函数体**，不要写函数签名、#include、JMLib 守卫——全部自动生成。花括号可写可不写（自动补齐并缩进）。
- C90 方言（arm-none-eabi-gcc）：变量声明放在块首。
- params：int/float 给 min/max/default/desc；硬件端口参数 type 用系统类型串（如 \`_MOTOR_\`，default/min/max 填 \`_M1_\`…\`_M8_\`），GUI 会显示端口选择器。
- 直接调用系统 API 即可；代码中用到的每个 API 所需的 JMLib.c 条件编译块会**自动收集**（sysDeps 自动扫描）。
- 调用其它自建模块：userDeps 列出模块名（须已生成于同一模块目录），像普通 C 函数一样调用。
- icon：三种取值——\`system:ApiName\`（官方照片风格，roboexp_icons/list_apis 可查）或 PNG 绝对路径（自绘见 roboexp_docs topic=icons：32×32 规范/配色/Pillow 模板）；roboexp_kb 参考模块自带推荐图标。
- **创建后必须全链接编译验证**（roboexp_compile_module）：func 语法检查发现不了拼写错的 API（隐式声明），只有探针全编译能抓出 undefined reference。`,

  apps: `# 主程序（CodeApp）编写规则

主程序编译为可下载到控制器的 .bin。

**先分清项目形态**：图形化项目（FlowApp）的主程序由用户在 GUI 里搭积木并下载，AI 只提供子程序模块（create_module/add_preset 传 project 参数即可）；只有纯 AI 代码主程序才走下面的 create_app 流程。

- code 是**完整编译单元**：
  1. 顶部 \`#include "../<模块名>.c"\` 引入每个用到的自建模块（模块在 app 的上一级目录，路径必须恰好是 \`../名字.c\`）；
  2. \`int main(void)\` 开头是否调 \`<SoftwareType>_Init();\` 取决于主控：先查 \`roboexp_controllers\` 的 initFuncName（实测 E7RCU/E6RCU/M6RCU/C6RCU/C1RCU 有，E3RCU/X3RCU/X4RCU/E2RCU/M 系无——没有就不要调）；
  3. 末尾 \`while(1);\` 防止 main 返回。
- 系统头不需要手写：编译器参数自动带 Include 目录；但系统 API 的 JMLib 守卫由各模块 .c 自带，所以**只通过模块干活，或直接调用系统 API 时把该 API 所在的模块也 include**——最稳做法是所有逻辑都放模块里，main 只做初始化+调度。
- userDeps 填用到的模块名（用于 .rcu 元数据，GUI 打开时可识别依赖）。
- 编译成功后在 apps/ 目录生成 <名字>.bin，用 RoboEXP 的下载功能烧录。`,

  apis: `# 系统 API 速查

- 各主控 API 数量不同（实测 E7RCU 229 / E6RCU 235 / M6RCU 234 / C6RCU 229 / X4RCU 228 / E3RCU 198 …，\`roboexp_controllers\` 可查全部）。常用：SetMotor/SetInBeep/SetWaitForTime/GetLightSensor/GetUltrasound/GetSysTime/SetMusicNote…。用 \`roboexp_list_apis\` 按关键词查，返回签名、参数范围、中文说明、图标提示。
- 参数类型为 \`_XXX_\` 形式（如 \`_MOTOR_\`）的是硬件端口，调用时传宏字面量（范围见该参数 min..max，例如马达 \`_M1_\`…\`_M8_\`，舵机 \`_S1_\`…）。
- 常用语义：SetMotor(端口, -100..100)（负=反转）；SetWaitForTime(秒) 阻塞等待；SetLed/SetInBeep 声光输出；GetInSensor 等读输入。
- jmkernel.o 里存在少量未写入 JMlib.xml 的函数（如 SetMotorX）——**不在表里的函数不要用**，strict 编译会拦截。`,

  sensors: `# 传感器与输入 API 速查（以 E7RCU 为例）

- 光电/黑线：GetLightSensor(端口) 模拟值；GetLightSensorThreshold(端口) 同口阈值；SetLightSensorLed(端口, 0/1) 补光灯（循迹建议开）；SetLightSensorThreshold(端口, 0..4095)。
- 超声测距：GetUltrasound(端口) 返回距离 **4..180 cm**；888=超出测距范围、999=读数出错——**必须过滤**再比较（if (d >= 4 && d <= 180) ...）。
- 触碰：GetTouch / GetTouchA / GetTouchB；触摸屏 GetTouchScreen / X / Y。
- 颜色：GetColorSensor / SetColorSensor。
- 计时：GetSysTime() 毫秒（int，会回绕，用差值判断）；SetSysTime() 清零。轮询周期控制的标准写法：记录上次时刻，dt<周期直接跳过。
- 音乐：SetMusicNote / SetMusicPlayer / SetMusicPlay / SetMusicRepeat / GetMusicState。
- 显示：SetLCDClear / SetDisplayString / SetDisplayVar / SetLCDBack / SetLCDLine。
- 端口读写：GetRcuPortData / SetRcuPortData。

硬件端口参数一律传宏字面量（_P1_.._P8_、_M1_.._M8_，范围见 list_apis 各参数 min..max）。
其余 API 用 roboexp_list_apis 关键词查；官方示例用法用 roboexp_examples + roboexp_module_info 查。`,

  multitask: `# 多任务编程（重要核实结论）

官方手册附录的 CodeEditor 多任务配方（_MAIN_TASK_DISABLE_ + _TASK_1_.._TASK_8_ 宏 + Task1..8 函数 + Create_Task()）**对应旧版本软件**：
当前 v6.0.8 全部 13 种主控的 JMLib.c 都不含这些宏，内核里 Create_Task 是未定义符号——照抄手册代码会链接失败。**不要使用该配方**。

当前可行的并行效果（时间片轮转，实战验证过的模式）：单 main + GetSysTime() 差值分时：

    int main(void)
    {
        int tA = 0, tB = 0;
        E7RCU_Init();               /* 仅当该主控导出 Init，见 roboexp_controllers */
        while (1)
        {
            if (GetSysTime() - tA >= 10)  { tA = GetSysTime(); /* 10ms 任务：巡迹 */ }
            if (GetSysTime() - tB >= 500) { tB = GetSysTime(); /* 500ms 任务：播报/显示 */ }
        }
    }

注意：阻塞 API（SetWaitForTime、长循环）会独占 CPU，多动作并行时每个时间片内只做非阻塞小步动作（预设 line_follow 内部就是 10ms 控制周期的范例）。`,

  pid: `# 竞赛巡线与调参知识（原创整理）

完整经验与参考实现用 roboexp_kb 检索（5 个编译验证的竞赛模块 + 8 条经验）。

**路口判定（编号约定）**：压线停=指定传感器压到线计一次；脱线停=整组巡线传感器离开线计一次。判定传感器用编号直接指定——分立光电填端口号 1-8（即 P1-P8，_P1_.._P8_ 宏值就是 1..8 可直接传 API）；寻迹卡填通道号 1-7（GetTraceV2I2C(口,通道号) 读相对光值、(口,10+通道号) 读参考值）。计数必须做边沿判别（记录上次状态），否则同一条线会被重复计数。

**光电配置**（事实要点）：四光电布局抗干扰最强（外侧两枚专判路口）；两光电紧贴布局时脱线停反而更可靠；超宽间距布局下中间光电常脱线，只能用压线停。光电离地 15-20mm；光轴距（光电到车轴）小于线宽一半。

**锁线力度经验**：速度 70 → 力度约 80，速度每 ±10 力度 ±10；过大抖动/路口误判，过小弯道脱线；急弯加力、长直减力。

**编码器事实**：标准高速马达一圈≈780 编码；水晶头黑色≈异型（一圈≈1080-1200）。转角跑偏先查打滑、轮距设置、马达类型，再谈调参。

**前冲标定**：先量准光轴距，直角路口双压线停标定到车轴停在下一段线起点，基准 100 每次 ±10；前冲突变先擦轮胎和地图。

**曲线技巧**：过弯先降速；弧线用内外轮差速跟随（外侧加速内侧减速）比停车原地转更快；虚线用"连续丢线时长"区分间隙与真丢线，虚线路口不转向。

**故障速查**：往两边跑=白线忘切颜色判定/接线反；路口停不下=地图脏或阈值需重标；转向判错=轮胎蹭车身或地图脏；同类问题换场地后集中出现=重新标定。`,

  icons: `# 模块图标绘制指南（32×32 PNG）

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

风格要点：黑色描边框住整个图标、元素大而少、高饱和纯色、不用渐变与阴影（32px 下会糊成噪点）。`,
}

// ---------------------------------------------------------------- preset module catalog
// All bodies use only call patterns already verified against the real toolchain
// (SetMotor/SetWaitForTime/SetInBeep, MyMove/MyDance/MyBeepTimes round-trips).

type PresetParam = {
  name: string
  type: string
  default: string
  min: string
  max: string
  desc: string
}

interface Preset {
  id: string
  name: string
  caption: string
  description: string
  icon: string
  params: PresetParam[]
  code: string
}

const P = (name: string, type: string, def: string, min: string, max: string, desc: string): PresetParam =>
  ({ name, type, default: def, min, max, desc })

const PRESETS: Preset[] = [
  {
    id: 'forward', name: 'Forward', caption: '前进', description: '双马达同速前进指定秒数后停止',
    icon: 'system:SetMotor',
    params: [P('speed', 'int', '60', '1', '100', '速度(1-100)'), P('seconds', 'float', '1', '0.1', '60', '持续秒数')],
    code: `{
    SetMotor(_M1_, speed);
    SetMotor(_M2_, speed);
    SetWaitForTime(seconds);
    SetMotor(_M1_, 0);
    SetMotor(_M2_, 0);
}`,
  },
  {
    id: 'backward', name: 'Backward', caption: '后退', description: '双马达同速后退指定秒数后停止',
    icon: 'system:SetMotor',
    params: [P('speed', 'int', '60', '1', '100', '速度(1-100)'), P('seconds', 'float', '1', '0.1', '60', '持续秒数')],
    code: `{
    SetMotor(_M1_, -speed);
    SetMotor(_M2_, -speed);
    SetWaitForTime(seconds);
    SetMotor(_M1_, 0);
    SetMotor(_M2_, 0);
}`,
  },
  {
    id: 'spin_left', name: 'SpinLeft', caption: '原地左转', description: '左右轮反向旋转原地转向（实际方向取决于接线，不对就对调左右）',
    icon: 'system:SetMotor',
    params: [P('speed', 'int', '60', '1', '100', '速度(1-100)'), P('seconds', 'float', '0.5', '0.1', '60', '持续秒数')],
    code: `{
    SetMotor(_M1_, -speed);
    SetMotor(_M2_, speed);
    SetWaitForTime(seconds);
    SetMotor(_M1_, 0);
    SetMotor(_M2_, 0);
}`,
  },
  {
    id: 'spin_right', name: 'SpinRight', caption: '原地右转', description: '左右轮反向旋转原地转向（与 SpinLeft 方向相反）',
    icon: 'system:SetMotor',
    params: [P('speed', 'int', '60', '1', '100', '速度(1-100)'), P('seconds', 'float', '0.5', '0.1', '60', '持续秒数')],
    code: `{
    SetMotor(_M1_, speed);
    SetMotor(_M2_, -speed);
    SetWaitForTime(seconds);
    SetMotor(_M1_, 0);
    SetMotor(_M2_, 0);
}`,
  },
  {
    id: 'stop', name: 'StopMotors', caption: '停车', description: '立即停止双马达',
    icon: 'system:SetMotor',
    params: [],
    code: `{
    SetMotor(_M1_, 0);
    SetMotor(_M2_, 0);
}`,
  },
  {
    id: 'beep_times', name: 'BeepTimes', caption: '鸣笛', description: '蜂鸣器响 n 次（0.2 秒开 0.2 秒关）',
    icon: 'system:SetInBeep',
    params: [P('n', 'int', '2', '1', '100', '响的次数')],
    code: `{
    int i;
    for (i = 0; i < n; i++)
    {
        SetInBeep(ON);
        SetWaitForTime(0.2);
        SetInBeep(OFF);
        SetWaitForTime(0.2);
    }
}`,
  },
  {
    id: 'beep_seconds', name: 'BeepSeconds', caption: '长鸣', description: '蜂鸣器持续响指定秒数',
    icon: 'system:SetInBeep',
    params: [P('seconds', 'float', '1', '0.1', '60', '持续秒数')],
    code: `{
    SetInBeep(ON);
    SetWaitForTime(seconds);
    SetInBeep(OFF);
}`,
  },
  {
    id: 'dance', name: 'Dance', caption: '欢乐舞', description: '左右摇摆 n 次的小舞蹈',
    icon: 'system:SetMotor',
    params: [P('times', 'int', '3', '1', '50', '摇摆次数'), P('speed', 'int', '60', '1', '100', '速度(1-100)')],
    code: `{
    int i;
    for (i = 0; i < times; i++)
    {
        SetMotor(_M1_, -speed);
        SetMotor(_M2_, speed);
        SetWaitForTime(0.3);
        SetMotor(_M1_, speed);
        SetMotor(_M2_, -speed);
        SetWaitForTime(0.3);
    }
    SetMotor(_M1_, 0);
    SetMotor(_M2_, 0);
}`,
  },
  {
    id: 'wait', name: 'Wait', caption: '等待', description: '原地等待指定秒数',
    icon: 'system:SetWaitForTime',
    params: [P('seconds', 'float', '1', '0.1', '3600', '等待秒数')],
    code: `{
    SetWaitForTime(seconds);
}`,
  },
  {
    id: 'walk_square', name: 'WalkSquare', caption: '走正方形', description: '前进+原地转组合走出正方形回路（边长与转向时长取决于车速，需实调）',
    icon: 'system:SetMotor',
    params: [P('speed', 'int', '60', '1', '100', '速度(1-100)'), P('seconds', 'float', '1', '0.1', '30', '每边行进秒数'), P('turnSeconds', 'float', '0.5', '0.1', '5', '每次转向秒数(90°)')],
    code: `{
    int i;
    for (i = 0; i < 4; i++)
    {
        SetMotor(_M1_, speed);
        SetMotor(_M2_, speed);
        SetWaitForTime(seconds);
        SetMotor(_M1_, -speed);
        SetMotor(_M2_, speed);
        SetWaitForTime(turnSeconds);
    }
    SetMotor(_M1_, 0);
    SetMotor(_M2_, 0);
}`,
  },
  {
    id: 'line_follow', name: 'LineFollow', caption: '走黑线', description: '双光电传感器 PD 循迹（含丢线原地找回、2 秒丢线停车；阈值自动兜底）',
    icon: 'system:GetLightSensor',
    params: [
      P('lightL', '_PORT_', '_P1_', '_P1_', '_P8_', '左光电端口'),
      P('lightR', '_PORT_', '_P2_', '_P1_', '_P8_', '右光电端口'),
      P('motorL', '_MOTOR_', '_M1_', '_M1_', '_M8_', '左马达'),
      P('motorR', '_MOTOR_', '_M2_', '_M1_', '_M8_', '右马达'),
      P('speed', 'int', '50', '10', '100', '基础速度'),
      P('kp', 'int', '30', '1', '100', '比例系数'),
      P('kd', 'int', '10', '0', '100', '微分系数'),
      P('seconds', 'float', '0', '0', '3600', '行驶秒数，0=一直走'),
    ],
    code: `{
    static int s_lastErr = 0;
    static int s_lastTurn = 0;
    static int s_lastTime = 0;
    static int s_lostMs = 0;
    int t0, t, dt, rawL, rawR, thL, thR, dL, dR, err, turn, left, right;

    SetLightSensorLed(lightL, 1);
    SetLightSensorLed(lightR, 1);
    SetWaitForTime(0.05);

    t0 = GetSysTime();
    s_lastTime = t0;
    while (1)
    {
        if (seconds > 0.0 && GetSysTime() - t0 >= (int)(seconds * 1000.0)) break;

        t = GetSysTime();
        dt = t - s_lastTime;
        if (dt < 0) dt = 10;
        if (dt < 10)
        {
            SetWaitForTime(0.001);
            continue;
        }
        s_lastTime = t;

        rawL = GetLightSensor(lightL);
        rawR = GetLightSensor(lightR);
        thL = GetLightSensorThreshold(lightL);
        thR = GetLightSensorThreshold(lightR);
        if (thL < 50) thL = 700;
        if (thR < 50) thR = 700;

        dL = (thL - rawL) * 100 / thL;
        dR = (thR - rawR) * 100 / thR;
        if (dL < 0) dL = 0;
        if (dL > 100) dL = 100;
        if (dR < 0) dR = 0;
        if (dR > 100) dR = 100;

        err = dL - dR;

        if (dL < 15 && dR < 15)
        {
            s_lostMs = s_lostMs + dt;
            if (s_lostMs < 2000)
            {
                if (s_lastTurn >= 0)
                {
                    SetMotor(motorL, -speed / 2);
                    SetMotor(motorR, speed / 2);
                }
                else
                {
                    SetMotor(motorL, speed / 2);
                    SetMotor(motorR, -speed / 2);
                }
                SetWaitForTime(0.01);
                continue;
            }
            SetMotor(motorL, 0);
            SetMotor(motorR, 0);
            break;
        }
        s_lostMs = 0;

        turn = kp * err / 100;
        turn = turn + kd * (err - s_lastErr) / 100;

        left = speed - turn;
        right = speed + turn;
        if (left > 100) left = 100;
        if (left < -100) left = -100;
        if (right > 100) right = 100;
        if (right < -100) right = -100;

        SetMotor(motorL, left);
        SetMotor(motorR, right);

        s_lastErr = err;
        s_lastTurn = turn;

        SetWaitForTime(0.01);
    }
}`,
  },
  {
    id: 'obstacle_avoid', name: 'ObstacleAvoid', caption: '超声避障', description: '超声波测距避障行走：距离小于阈值时后退并转向绕开（返回 888/999 已过滤）',
    icon: 'system:GetUltrasound',
    params: [
      P('sonar', '_PORT_', '_P1_', '_P1_', '_P8_', '超声模块端口'),
      P('motorL', '_MOTOR_', '_M1_', '_M1_', '_M8_', '左马达'),
      P('motorR', '_MOTOR_', '_M2_', '_M1_', '_M8_', '右马达'),
      P('speed', 'int', '50', '10', '100', '速度'),
      P('distCm', 'int', '20', '5', '100', '避障距离阈值(cm)'),
    ],
    code: `{
    int d;
    while (1)
    {
        d = GetUltrasound(sonar);
        if (d >= 4 && d <= 180 && d < distCm)
        {
            SetMotor(motorL, 0);
            SetMotor(motorR, 0);
            SetWaitForTime(0.1);
            SetMotor(motorL, -speed);
            SetMotor(motorR, -speed);
            SetWaitForTime(0.5);
            SetMotor(motorL, -speed);
            SetMotor(motorR, speed);
            SetWaitForTime(0.4);
        }
        else
        {
            SetMotor(motorL, speed);
            SetMotor(motorR, speed);
        }
        SetWaitForTime(0.05);
    }
}`,
  },
  {
    id: 'go_encoder', name: 'GoEncoder', caption: '编码走直线', description: '编码器闭环走直线：双轮编码差实时纠偏，走满目标编码值停车（标准高速马达一圈=780，异型≈1080）',
    icon: 'system:GetMotorCode',
    params: [
      P('motorL', '_MOTOR_', '_M1_', '_M1_', '_M8_', '左马达'),
      P('motorR', '_MOTOR_', '_M2_', '_M1_', '_M8_', '右马达'),
      P('speed', 'int', '50', '10', '100', '速度'),
      P('target', 'long', '780', '1', '1000000', '目标编码值（一圈=780）'),
    ],
    code: `{
    static int s_dir = 0;
    long baseL, baseR, cl, cr, diff;
    int l, r;

    SetMotorCode(motorL);
    SetMotorCode(motorR);
    baseL = GetMotorCode(motorL);
    baseR = GetMotorCode(motorR);

    if (s_dir == 0)
    {
        s_dir = (GetMotorCode(motorL) >= baseL) ? 1 : -1;
    }

    while (1)
    {
        cl = GetMotorCode(motorL) - baseL;
        cr = GetMotorCode(motorR) - baseR;
        if (s_dir < 0)
        {
            cl = -cl;
            cr = -cr;
        }
        if (cl >= target && cr >= target) break;

        diff = cl - cr;
        l = speed - diff / 8;
        r = speed + diff / 8;
        if (l > 100) l = 100;
        if (l < -100) l = -100;
        if (r > 100) r = 100;
        if (r < -100) r = -100;
        SetMotor(motorL, l);
        SetMotor(motorR, r);
    }
    SetMotor(motorL, 0);
    SetMotor(motorR, 0);
}`,
  },
]

// ---------------------------------------------------------------- plugin entry

export function apply(ctx: Context, config: Config) {
  // ---- 1. docs -------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_docs',
    description: 'RoboEXP（中鸣机器人快车）开发指南。开始写任何模块/主程序之前先读对应主题：'
      + 'modules=子程序模块规则，apps=主程序规则，apis=系统API速查，workflow=推荐工作流。',
    parameters: {
      topic: { type: 'string', required: true, enum: ['workflow', 'modules', 'apps', 'apis', 'sensors', 'multitask', 'pid', 'icons'], description: '指南主题' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const t = GUIDES[args.topic]
      if (!t) throw new Error(`unknown topic: ${args.topic}`)
      return t
    },
  }))

  // ---- 2. preset catalog ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_list_presets',
    description: '列出可一键添加的现成 RoboEXP 子程序模块模板（前进/后退/转向/鸣笛/跳舞/走正方形…）。'
      + '用户想要的功能与某个预设匹配时，直接用 roboexp_add_preset 添加（自动创建+编译验证，一步完成），无需走自定义流程。'
      + '预设参数的默认值可在添加时覆盖。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute() {
      return PRESETS.map((p) => ({
        preset: p.id,
        name: p.name,
        caption: p.caption,
        description: p.description,
        icon: p.icon,
        params: p.params,
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roboexp_add_preset',
    description: '一键生成一个现成模块模板：写入 <工作区>/roboexp_modules/ 并立即做全链接编译验证，一步完成。'
      + '用户说「加一个前进模块」「加个鸣笛模块响3次」即可。参数默认值可用 paramDefaults 覆盖（如 {"speed": 80}）。'
      + '生成后把返回的 usage 指引告诉用户：在机器人快车里「项目 → 引用子程序」选择该 .rcu 即可使用。'
      + '不匹配任何预设的需求（走黑线、避障等）才走 roboexp_create_module 自定义流程。',
    parameters: {
      preset: { type: 'string', required: true, description: `预设 id：${PRESETS.map((p) => p.id).join(' / ')}` },
      name: { type: 'string', description: '生成的模块名（默认用预设自带名，如 Forward）' },
      caption: { type: 'string', description: 'GUI 显示名（默认用预设中文名）' },
      paramDefaults: {
        type: 'object',
        additionalProperties: true,
        description: '覆盖参数默认值，如 {"speed": 80, "seconds": 2}',
      },
      softwareType: { type: 'string', description: '控制器类型，默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const preset = PRESETS.find((p) => p.id === args.preset)
      if (!preset) {
        throw new Error(`unknown preset: ${args.preset}; available: ${PRESETS.map((p) => p.id).join(', ')}`)
      }
      const moduleName = args.name?.trim() || preset.name
      if (!NAME_RE.test(moduleName)) throw new Error(`invalid module name: ${moduleName}`)
      const rt = resolveRuntime(config, exec, args.softwareType)
      const params = preset.params.map((p) => {
        const overridden = args.paramDefaults && p.name in args.paramDefaults
          ? String((args.paramDefaults as Record<string, unknown>)[p.name])
          : p.default
        return { ...p, default: overridden, nameCHS: p.desc }
      })
      const spec: Record<string, unknown> = {
        name: moduleName,
        caption: args.caption?.trim() || preset.caption,
        description: preset.description,
        softwareType: rt.softwareType,
        outDir: rt.modulesDir,
        icon: preset.icon,
        author: 'dsh-roboexp',
        version: '1.0',
        register: 'false',
        params,
        sysDeps: [],
        userDeps: [],
        code: preset.code,
      }
      const specPath = path.join(rt.modulesDir, `${moduleName}.spec.json`)
      fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8')
      const out = await runFactory(['module', specPath], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 55_000, signal: exec.signal,
      })
      const created = parseLastJson(out.stdout)
      if (out.code !== 0 || !created?.ok) {
        throw new Error(`add_preset failed at creation: ${capLog(out.stderr || out.stdout || `exit ${out.code}`)}`)
      }
      // verify the fresh module with the full-link probe
      const comp = await runFactory(['compilestrict', created.c, rt.softwareType], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 110_000, signal: exec.signal,
      })
      const verdict = parseLastJson(comp.stdout)
      const res: any = {
        ok: Boolean(verdict?.ok),
        preset: preset.id,
        module: moduleName,
        caption: spec.caption,
        rcu: created.rcu,
        c: created.c,
        sysDeps: created.sysDeps,
        params: params.map((p) => ({ name: p.name, default: p.default })),
        compile: verdict ? { ok: verdict.ok, log: capLog(verdict.log ?? '') } : { ok: false, log: capLog(comp.stdout + comp.stderr) },
        usage: `机器人快车：打开你的项目 → 菜单「项目 → 引用子程序」（或子程序管理器 → 添加）→ 选择 ${created.rcu}。项目开着即可引用，模块面板的项目分组会立即出现「${args.caption?.trim() || preset.caption}」积木。`,
      }
      return res
    },
  }))

  // ---- 3. list apis --------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_list_apis',
    description: '按关键词查 RoboEXP 系统 API 表（来自 JMLib.xml，E7RCU 约 458 个）。'
      + '返回每个 API 的签名、参数类型/范围/默认值/中文说明，以及 icon 提示（创建模块时直接用 system:名字 作图标）。'
      + '关键词用英文功能词：motor、servo、led、beep、sensor、time、adc、uart…',
    parameters: {
      keyword: { type: 'string', description: '过滤关键词（API 名子串，不区分大小写）；留空返回全部（受 limit 限制）' },
      limit: { type: 'integer', description: '最多返回条数', default: 60 },
      softwareType: { type: 'string', description: '控制器类型，默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rt = resolveRuntime(config, exec, args.softwareType)
      const out = await runFactory(['apis', rt.softwareType, args.keyword ?? ''], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 25_000, signal: exec.signal,
      })
      if (out.code !== 0) throw new Error(`apis failed: ${capLog(out.stderr || out.stdout)}`)
      const list = parseLastJson(out.stdout)
      if (!Array.isArray(list)) throw new Error(`unexpected ModuleFactory output: ${capLog(out.stdout)}`)
      const limit = args.limit ?? 60
      return { total: list.length, shown: Math.min(list.length, limit), apis: list.slice(0, limit) }
    },
  }))

  // ---- 3b. controllers ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_controllers',
    description: '列出本机机器人快车安装的全部主控类型及实测能力：API 数量、官方示例数、内核是否导出 <类型>_Init 初始化函数。'
      + '换主控（E3RCU/E6RCU/M6RCU/X4RCU…）或写主程序 main 开头是否调 Init 时先查这里；'
      + 'initFuncName 为空的类型不要在 main 里调 <类型>_Init()。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const out = await runFactory(['controllers'], {
        cwd: process.cwd(), timeoutMs: 55_000, signal: exec.signal,
      })
      if (out.code !== 0) throw new Error(`controllers failed: ${capLog(out.stderr || out.stdout)}`)
      const res = parseLastJson(out.stdout)
      if (!Array.isArray(res)) throw new Error(`unexpected output: ${capLog(out.stdout)}`)
      return { controllers: res, total: res.length }
    },
  }))

  // ---- 3c. official examples -------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_examples',
    description: '官方示例程序索引（按分类列出机器人快车自带的示例：执行模块/光电/超声/无线/其他…，含中文名与 .rcu 路径）。'
      + '想参考官方用法时：先用 query 过滤，再用 roboexp_module_info 读某个示例 .rcu 的代码与参数。'
      + '示例多为图形化项目，info 读不到代码时提示用户在 GUI 里打开查看。',
    parameters: {
      query: { type: 'string', description: '按名称/中文名过滤（如 Ultra、Motor、蓝牙）' },
      softwareType: { type: 'string', description: '控制器类型，默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rt = resolveRuntime(config, exec, args.softwareType)
      const out = await runFactory(['examples', rt.softwareType, args.query ?? ''], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 25_000, signal: exec.signal,
      })
      if (out.code !== 0) throw new Error(`examples failed: ${capLog(out.stderr || out.stdout)}`)
      const res = parseLastJson(out.stdout)
      if (!Array.isArray(res)) throw new Error(`unexpected output: ${capLog(out.stdout)}`)
      return { softwareType: rt.softwareType, examples: res.slice(0, 50), total: res.length }
    },
  }))

  // ---- 3d. competition knowledge base ---------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_kb',
    description: '竞赛知识库（原创整理）：①参考模块库——5 个经编译验证的竞赛模式实现（遇线停计路口/巡线编码/差速转角/超声跟墙/紧巡线），'
      + '含完整代码与参数，可让 agent 按此模式定制生成；②经验条目——光电配置选型、锁线力度×速度联动、前冲标定、编码器事实（一圈≈780/异型≈1080）、'
      + '路口计数惯例（压线停2/4、脱线停1/5）、场地搭建、故障速查、曲线差速。'
      + '判定传感器一律用编号（分立光电=端口号1-8 / 寻迹卡=通道号1-7），不用抽象编码。用户咨询巡线/调参/故障排查/竞赛策略时查这里。query=关键词；module=模块名返回完整实现。',
    parameters: {
      query: { type: 'string', description: '搜索关键词（匹配模块名/说明/参数/经验标题与内容，如 遇线停/跟墙/锁线/编码/故障）' },
      module: { type: 'string', description: '参考模块名（CatchLine/LineBmp/TurnBmp/FollowWall/LineTight），返回完整代码与参数' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const kb = loadKb()
      if (args.module) {
        const mod = (kb.modules as any[]).find((mm) => mm.name === args.module)
        if (!mod) throw new Error(`模块 ${args.module} 不在知识库中：${(kb.modules as any[]).map((mm) => mm.name).join(', ')}`)
        const r1: any = { module: mod.name, caption: mod.caption, description: mod.description, icon: mod.icon, params: mod.params, code: mod.code }
        return r1
      }
      const q = (args.query ?? '').toLowerCase()
      const mods = (kb.modules as any[]).filter((mm) => !q
        || String(mm.name).toLowerCase().includes(q)
        || String(mm.caption).toLowerCase().includes(q)
        || String(mm.description).toLowerCase().includes(q)
        || mm.params.some((pp: any) => String(pp.desc).toLowerCase().includes(q)))
      const exp = (kb.experience as any[]).filter((e) => !q
        || String(e.title).toLowerCase().includes(q)
        || String(e.content).toLowerCase().includes(q)
        || e.id.includes(q))
      const r3: any = {
        modules: mods.map((mm) => ({ name: mm.name, caption: mm.caption, description: mm.description, icon: mm.icon, params: mm.params.length, tags: mm.tags })),
        experience: exp.map((e) => ({ id: e.id, title: e.title, content: e.content })),
        hint: 'module=<名字> 取完整实现代码；经验条目内容已直接给出',
      }
      return r3
    },
  }))

  // ---- 3e. icon catalog -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_icons',
    description: '模块图标目录，为 create_module/add_preset 的 icon 参数挑选官方照片风格图标（system:ApiName，与内置模块视觉一致）。'
      + 'icon 也接受 PNG 绝对路径；知识库参考模块自带推荐图标（见 roboexp_kb）。',
    parameters: {
      query: { type: 'string', description: '按 API 名过滤（如 Motor/Light/Ultra/Beep）' },
      softwareType: { type: 'string', description: '控制器类型（图标按主控），默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rt = resolveRuntime(config, exec, args.softwareType)
      const out = await runFactory(['sysicons', rt.softwareType, args.query ?? ''], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 25_000, signal: exec.signal,
      })
      let sys: string[] = []
      if (out.code === 0) {
        const res = parseLastJson(out.stdout)
        if (Array.isArray(res?.icons)) sys = res.icons
      }
      const r: any = {
        systemIcons: sys.slice(0, 80).map((n) => `system:${n}`),
        systemTotal: sys.length,
        usage: 'icon 参数传 "system:SetMotor" 这类值；roboexp_kb 的参考模块也带推荐图标',
      }
      return r
    },
  }))

  // ---- 4. create module ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_create_module',
    description: '生成 RoboEXP 子程序模块（<名字>.rcu + <名字>.c 写入 <工作区>/roboexp_modules/，已通过全链接编译）。'
      + '不做任何全局注册；用户在机器人快车里用「项目 → 引用子程序」选择生成的 .rcu 即可加入自己的项目（项目开着即可，面板即时刷新）。'
      + 'code 只写函数体（无签名/无 include，自动生成幂等守卫与 JMLib 条件块，用到的系统 API 自动收集）。'
      + 'icon 推荐 "system:ApiName" 复用官方照片风格图标。创建后必须用 roboexp_compile_module 验证。'
      + '同名重建即覆盖。详细规则先读 roboexp_docs topic=modules。',
    parameters: {
      name: { type: 'string', required: true, description: '模块名 = C 函数名（ASCII 标识符）' },
      code: { type: 'string', required: true, description: '函数体（花括号可省略）' },
      params: {
        type: 'array',
        description: '积木块参数',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'C 参数名' },
            type: { type: 'string', description: 'int / float / 硬件类型串如 _MOTOR_', default: 'int' },
            default: { type: 'string', description: '默认值' },
            min: { type: 'string', description: '最小值' },
            max: { type: 'string', description: '最大值' },
            desc: { type: 'string', description: '参数说明（中文）' },
            nameCHS: { type: 'string', description: 'GUI 显示的中文名' },
          },
        },
      },
      caption: { type: 'string', description: 'GUI 显示名（中文可）' },
      description: { type: 'string', description: '模块功能说明' },
      icon: { type: 'string', description: '"system:ApiName"（官方照片风格，推荐）或 PNG 绝对路径；roboexp_icons 挑选，roboexp_kb 参考模块带推荐图标' },
      userDeps: { type: 'array', items: { type: 'string' }, description: '依赖的其它自建模块名（须已生成）' },
      softwareType: { type: 'string', description: '控制器类型，默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      if (!NAME_RE.test(args.name)) throw new Error(`invalid module name: ${args.name} (ASCII C identifier required)`)
      const rt = resolveRuntime(config, exec, args.softwareType)
      const spec = {
        name: args.name,
        caption: args.caption ?? args.name,
        description: args.description ?? '',
        softwareType: rt.softwareType,
        outDir: rt.modulesDir,
        icon: args.icon ?? '',
        author: 'dsh-roboexp',
        version: '1.0',
        register: 'false',
        params: args.params ?? [],
        sysDeps: [],
        userDeps: args.userDeps ?? [],
        code: args.code,
      }
      const specPath = path.join(rt.modulesDir, `${args.name}.spec.json`)
      fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8')
      const out = await runFactory(['module', specPath], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 55_000, signal: exec.signal,
      })
      const res = parseLastJson(out.stdout)
      if (out.code !== 0 || !res?.ok) {
        throw new Error(`create_module failed: ${capLog(out.stderr || out.stdout || `exit ${out.code}`)}`)
      }
      res.usage = `机器人快车：打开你的项目 → 菜单「项目 → 引用子程序」（或子程序管理器 → 添加）→ 选择 ${res.rcu}。项目开着即可引用，模块面板的项目分组会立即出现新积木。`
      return res
    },
  }))

  // ---- 5. compile module (strict full-link probe) --------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_compile_module',
    description: '全链接验证一个模块：自动生成调用该模块的探针 main 并完整编译（链接 jmkernel.o）。'
      + '能抓出 func 语法检查漏掉的 undefined reference（拼错的 API 名等）。'
      + 'ok:false 时 log 含 arm-none-eabi-gcc 的 file:line 错误，据此修复后用 roboexp_create_module 覆盖重建再验。',
    parameters: {
      name: { type: 'string', required: true, description: '模块名（模块目录下的 <名字>.c）' },
      softwareType: { type: 'string', description: '控制器类型，默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const rt = resolveRuntime(config, exec, args.softwareType)
      const c = path.join(rt.modulesDir, `${args.name}.c`)
      if (!fs.existsSync(c)) {
        const existing = fs.readdirSync(rt.modulesDir).filter((f) => f.endsWith('.c')).join(', ')
        throw new Error(`module ${args.name} not found (${c}); existing .c files: ${existing || '(none)'}`)
      }
      const out = await runFactory(['compilestrict', c, rt.softwareType], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 110_000, signal: exec.signal,
      })
      const res = parseLastJson(out.stdout)
      if (!res) throw new Error(`compile_module produced no verdict: ${capLog(out.stdout + out.stderr)}`)
      if (typeof res.log === 'string') res.log = capLog(res.log)
      return res
    },
  }))

  // ---- 6. create app -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_create_app',
    description: '创建 RoboEXP 主程序（CodeApp，生成 <名字>.rcu + <名字>.c 于模块目录的 apps/ 子目录）。'
      + 'code 是完整编译单元：顶部 #include "../<模块名>.c"，main 开头 <SoftwareType>_Init();（如 E7RCU_Init();），'
      + '结尾 while(1);。写之前先读 roboexp_docs topic=apps。创建后用 roboexp_compile_app 编译出 .bin。',
    parameters: {
      name: { type: 'string', required: true, description: '主程序名（ASCII 标识符）' },
      code: { type: 'string', required: true, description: '完整 C 源（includes + int main(void){...}）' },
      userDeps: { type: 'array', items: { type: 'string' }, description: '用到的自建模块名' },
      caption: { type: 'string', description: 'GUI 显示名' },
      description: { type: 'string', description: '程序说明' },
      icon: { type: 'string', description: '"system:ApiName" 或 PNG 路径' },
      softwareType: { type: 'string', description: '控制器类型，默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      if (!NAME_RE.test(args.name)) throw new Error(`invalid app name: ${args.name}`)
      const rt = resolveRuntime(config, exec, args.softwareType)
      const appsDir = path.join(rt.modulesDir, 'apps')
      fs.mkdirSync(appsDir, { recursive: true })
      const spec = {
        name: args.name,
        caption: args.caption ?? args.name,
        description: args.description ?? '',
        softwareType: rt.softwareType,
        outDir: appsDir,
        icon: args.icon ?? '',
        author: 'dsh-roboexp',
        version: '1.0',
        userDeps: args.userDeps ?? [],
        code: args.code,
      }
      const specPath = path.join(appsDir, `${args.name}.spec.json`)
      fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8')
      const out = await runFactory(['app', specPath], {
        roboDir: rt.roboDir, cwd: appsDir, timeoutMs: 55_000, signal: exec.signal,
      })
      const res = parseLastJson(out.stdout)
      if (out.code !== 0 || !res?.ok) {
        throw new Error(`create_app failed: ${capLog(out.stderr || out.stdout || `exit ${out.code}`)}`)
      }
      return res
    },
  }))

  // ---- 7. compile app ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_compile_app',
    description: '编译主程序（apps/ 目录下 <名字>.c）生成可烧录的 <名字>.bin。'
      + 'ok:false 时 log 含 arm-none-eabi-gcc 链接错误（常见：模块名拼错、忘写 #include "../<模块>.c"）。',
    parameters: {
      name: { type: 'string', required: true, description: '主程序名' },
      softwareType: { type: 'string', description: '控制器类型，默认 E7RCU' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const rt = resolveRuntime(config, exec, args.softwareType)
      const appsDir = path.join(rt.modulesDir, 'apps')
      const c = path.join(appsDir, `${args.name}.c`)
      if (!fs.existsSync(c)) {
        const existing = fs.existsSync(appsDir)
          ? fs.readdirSync(appsDir).filter((f) => f.endsWith('.c')).join(', ') : '(no apps dir)'
        throw new Error(`app ${args.name} not found (${c}); existing .c files: ${existing}`)
      }
      const out = await runFactory(['compile', c, 'main', rt.softwareType], {
        roboDir: rt.roboDir, cwd: appsDir, timeoutMs: 110_000, signal: exec.signal,
      })
      const log = capLog(out.stdout + out.stderr)
      const ok = out.code === 0 && /COMPILE OK/.test(out.stdout)
      const res: any = { ok, app: args.name, log }
      if (ok) res.bin = path.join(appsDir, `${args.name}.bin`)
      return res
    },
  }))

  // ---- 8. list modules -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_list_modules',
    description: '列出已生成的模块与主程序母本（扫描模块目录 <工作区>/roboexp_modules/，含 apps/ 子目录），按修改时间排序。'
      + '这些母本通过机器人快车「项目 → 引用子程序」加入用户项目。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const rt = resolveRuntime(config, exec)
      const out = await runFactory(['peekdirs', rt.modulesDir], {
        roboDir: rt.roboDir, cwd: rt.modulesDir, timeoutMs: 25_000, signal: exec.signal,
      })
      if (out.code !== 0) throw new Error(`list_modules failed: ${capLog(out.stderr || out.stdout)}`)
      const all = parseLastJson(out.stdout)
      if (!Array.isArray(all)) throw new Error(`unexpected output: ${capLog(out.stdout)}`)
      return {
        modulesDir: rt.modulesDir,
        items: all.slice(0, 50).map((m: any) => {
          const item: any = { name: m.name, type: m.type, mtime: m.mtime, rcu: m.path }
          if (m.type === 'CodeFunc' || m.type === 'FlowFunc') {
            item.usage = `机器人快车「项目 → 引用子程序」选择 ${m.path}`
          }
          return item
        }),
        total: all.length,
      }
    },
  }))

  // ---- 9. module info ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'roboexp_module_info',
    description: '读取一个 .rcu（模块或主程序）的元数据：参数、返回类型、依赖、全局区与函数体代码。'
      + '用于查看某个已存在模块的真实实现/签名（比如 GUI 里看到的内置模块）。',
    parameters: {
      rcu: { type: 'string', required: true, description: '.rcu 文件路径（相对会话工作区或绝对路径）' },
    },
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let p = args.rcu
      if (!path.isAbsolute(p)) p = path.resolve(sessionCwd(exec), p)
      if (!fs.existsSync(p)) throw new Error(`not found: ${p}`)
      const out = await runFactory(['info', p], {
        cwd: path.dirname(p), timeoutMs: 25_000, signal: exec.signal,
      })
      if (out.code !== 0) throw new Error(`module_info failed: ${capLog(out.stderr || out.stdout)}`)
      const res = parseLastJson(out.stdout)
      if (!res) throw new Error(`unexpected output: ${capLog(out.stdout)}`)
      return res
    },
  }))

}
