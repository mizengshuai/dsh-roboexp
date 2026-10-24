# 子程序模块（CodeFunc）编写规则

模块 = 一个 C 子函数。母本保存在 <工作区>/roboexp_modules/；用户在 GUI 通过「项目 → 引用子程序」把模块加进自己的项目（自动复制进项目目录、项目分组即时出现）。不做全局模块库注册。

- name：ASCII C 标识符，不能与系统模块重名。
- code：**只写函数体**，不要写函数签名、#include、JMLib 守卫——全部自动生成。花括号可写可不写（自动补齐并缩进）。
- C90 方言（arm-none-eabi-gcc）：变量声明放在块首。
- params：int/float 给 min/max/default/desc；硬件端口参数 type 用系统类型串（如 `_MOTOR_`，default/min/max 填 `_M1_`…`_M8_`），GUI 会显示端口选择器。
- 直接调用系统 API 即可；代码中用到的每个 API 所需的 JMLib.c 条件编译块会**自动收集**（sysDeps 自动扫描）。
- 调用其它自建模块：userDeps 列出模块名（须已生成于同一模块目录），像普通 C 函数一样调用。
- icon：三种取值——`system:ApiName`（官方照片风格，roboexp_icons/list_apis 可查）或 PNG 绝对路径（自绘见 roboexp_docs topic=icons：32×32 规范/配色/Pillow 模板）；roboexp_kb 参考模块自带推荐图标。
- **创建后必须全链接编译验证**（roboexp_compile_module）：func 语法检查发现不了拼写错的 API（隐式声明），只有探针全编译能抓出 undefined reference。

---

# 主程序（CodeApp）编写规则

主程序编译为可下载到控制器的 .bin。

**先分清项目形态**：图形化项目（FlowApp）的主程序由用户在 GUI 里搭积木并下载，AI 只提供子程序模块（create_module/add_preset 传 project 参数即可）；只有纯 AI 代码主程序才走下面的 create_app 流程。

- code 是**完整编译单元**：
  1. 顶部 `#include "../<模块名>.c"` 引入每个用到的自建模块（模块在 app 的上一级目录，路径必须恰好是 `../名字.c`）；
  2. `int main(void)` 开头是否调 `<SoftwareType>_Init();` 取决于主控：先查 `roboexp_controllers` 的 initFuncName（实测 E7RCU/E6RCU/M6RCU/C6RCU/C1RCU 有，E3RCU/X3RCU/X4RCU/E2RCU/M 系无——没有就不要调）；
  3. 末尾 `while(1);` 防止 main 返回。
- 系统头不需要手写：编译器参数自动带 Include 目录；但系统 API 的 JMLib 守卫由各模块 .c 自带，所以**只通过模块干活，或直接调用系统 API 时把该 API 所在的模块也 include**——最稳做法是所有逻辑都放模块里，main 只做初始化+调度。
- userDeps 填用到的模块名（用于 .rcu 元数据，GUI 打开时可识别依赖）。
- 编译成功后在 apps/ 目录生成 <名字>.bin，用 RoboEXP 的下载功能烧录。

---

# 多任务编程（重要核实结论）

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

注意：阻塞 API（SetWaitForTime、长循环）会独占 CPU，多动作并行时每个时间片内只做非阻塞小步动作（预设 line_follow 内部就是 10ms 控制周期的范例）。
