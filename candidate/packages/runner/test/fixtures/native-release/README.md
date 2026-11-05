# PE 版本测试输入

三份 DLL 是本项目空类 `NativeFixture.cs` 的固定编译产物，只供 PE 版本读取测试，不执行其中代码。
`release-native.test.ts` 复制它们到临时目录后执行原有 PE、ZIP、资源拒绝和 33 MiB 流式读取断言。
`native-product-build.test.ts` 继续在 CI 实际编译项目、验证凭据隔离并读取产物版本。

生成环境：Windows，现有 .NET SDK **10.0.402**；目标 `net10.0`，默认 Debug。
三份文件各 **4096 bytes**，`FileVersion` 均为 `1.2.3.0`。

| 文件 | ProductVersion | SHA-256 |
| --- | --- | --- |
| `fixture.dll` | `1.2.3+fixture` | `2b97c45b461b5480e6ce9b5fc9c19c58efc7b54bcf08b0936e51babec048d220` |
| `fixture-0.dll` | `1.2.3.0` | `7e4f4f7a7702f3e34db898d23e9be66387bb10154f6fcd3c00048698519d8892` |
| `fixture-4.dll` | `1.2.3.4` | `da3eb530079a7aab000093396de17c3a60fc2a90fd9f629f0a68d384e34b1c36` |

## 重新生成

仅在输入源码或测试语义变化时重新生成，不在常规 CI 中构建这些输入。
使用已有的 SDK 10.0.402，将本目录的 `NativeFixture.cs` 和 `NativeFixture.csproj` 复制到空的临时 `source` 目录。
以下 PowerShell 命令中，`$fixtureSource` 是该目录的绝对路径，`$fixtureOutput` 是与它并列的空输出目录；`dotnet` 应指向上述 SDK。

```powershell
dotnet build "$fixtureSource/NativeFixture.csproj" -o "$fixtureOutput/base" '-p:InformationalVersion=1.2.3+fixture' "-p:PathMap=$fixtureSource=/_/native-release-fixture"
dotnet build "$fixtureSource/NativeFixture.csproj" -o "$fixtureOutput/zero" '-p:InformationalVersion=1.2.3.0' "-p:PathMap=$fixtureSource=/_/native-release-fixture"
dotnet build "$fixtureSource/NativeFixture.csproj" -o "$fixtureOutput/nonzero" '-p:InformationalVersion=1.2.3.4' "-p:PathMap=$fixtureSource=/_/native-release-fixture"
```

按顺序将三个输出目录中的 `NativeFixture.dll` 保存为 `fixture.dll`、`fixture-0.dll`、`fixture-4.dll`。
保留正常用户目录或项目既有隔离用户目录配置；生成不需要凭据。
生成后用 `System.Diagnostics.FileVersionInfo` 核对版本，记录 `Get-FileHash -Algorithm SHA256`，并运行既有 `release-native.test.ts`。
源码启用确定性编译、固定源路径映射，并关闭 Git revision 自动追加；以上记录绑定本次实际字节，尚未通过第二次独立生成宣称逐字节重现。

## 方法参考

.NET 官方 [symreader-converter 的固定 DLL 与生成命令](https://github.com/dotnet/symreader-converter/blob/8ba28197d3bbe6d119497d41cfef0a310a490081/src/PdbTestResources/Resources/Async.cmd)
及其 [嵌入资源配置](https://github.com/dotnet/symreader-converter/blob/8ba28197d3bbe6d119497d41cfef0a310a490081/src/PdbTestResources/PdbTestResources.csproj)
采用随仓二进制测试输入；本目录 DLL 均由本项目源码生成，未复制第三方二进制。
