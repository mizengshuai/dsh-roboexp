# 传感器与输入 API 速查（以 E7RCU 为例）

- 光电/黑线：GetLightSensor(端口) 模拟值；GetLightSensorThreshold(端口) 同口阈值；SetLightSensorLed(端口, 0/1) 补光灯（循迹建议开）；SetLightSensorThreshold(端口, 0..4095)。
- 超声测距：GetUltrasound(端口) 返回距离 **4..180 cm**；888=超出测距范围、999=读数出错——**必须过滤**再比较（if (d >= 4 && d <= 180) ...）。
- 触碰：GetTouch / GetTouchA / GetTouchB；触摸屏 GetTouchScreen / X / Y。
- 颜色：GetColorSensor / SetColorSensor。
- 计时：GetSysTime() 毫秒（int，会回绕，用差值判断）；SetSysTime() 清零。轮询周期控制的标准写法：记录上次时刻，dt<周期直接跳过。
- 音乐：SetMusicNote / SetMusicPlayer / SetMusicPlay / SetMusicRepeat / GetMusicState。
- 显示：SetLCDClear / SetDisplayString / SetDisplayVar / SetLCDBack / SetLCDLine。
- 端口读写：GetRcuPortData / SetRcuPortData。

硬件端口参数一律传宏字面量（_P1_.._P8_、_M1_.._M8_，范围见 list_apis 各参数 min..max）。
其余 API 用 roboexp_list_apis 关键词查；官方示例用法用 roboexp_examples + roboexp_module_info 查。

---

# 系统 API 速查

- 各主控 API 数量不同（实测 E7RCU 229 / E6RCU 235 / M6RCU 234 / C6RCU 229 / X4RCU 228 / E3RCU 198 …，`roboexp_controllers` 可查全部）。常用：SetMotor/SetInBeep/SetWaitForTime/GetLightSensor/GetUltrasound/GetSysTime/SetMusicNote…。用 `roboexp_list_apis` 按关键词查，返回签名、参数范围、中文说明、图标提示。
- 参数类型为 `_XXX_` 形式（如 `_MOTOR_`）的是硬件端口，调用时传宏字面量（范围见该参数 min..max，例如马达 `_M1_`…`_M8_`，舵机 `_S1_`…）。
- 常用语义：SetMotor(端口, -100..100)（负=反转）；SetWaitForTime(秒) 阻塞等待；SetLed/SetInBeep 声光输出；GetInSensor 等读输入。
- jmkernel.o 里存在少量未写入 JMlib.xml 的函数（如 SetMotorX）——**不在表里的函数不要用**，strict 编译会拦截。
