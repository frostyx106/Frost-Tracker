param([switch]$ProbeOnly)

$ErrorActionPreference = 'Stop'

function Write-Result {
  param([bool]$Ok, [string]$Message)
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $Ok; message = $Message } -Compress))
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RiotLoginInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms

  $payload = $null
  if (-not $ProbeOnly) {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($payload.username) -or [string]::IsNullOrEmpty($payload.password)) {
      throw 'The selected vault entry is missing a username or password.'
    }
  }

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $riotWindowFound = $false
  $windowRestoreRequested = $false
  $logoutRequested = $false
  $logoutConfirmationInvoked = $false
  $identityMenuExpanded = $false

  while ($watch.Elapsed.TotalSeconds -lt 25) {
    $riotProcess = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match '^Riot Client$' } |
      Select-Object -First 1

    if (-not $riotProcess) {
      [System.Threading.Thread]::Sleep(250)
      continue
    }

    $riotWindowFound = $true
    $windowHandle = [IntPtr]$riotProcess.MainWindowHandle
    if (-not $windowRestoreRequested) {
      if ([RiotLoginInput]::IsIconic($windowHandle)) {
        [RiotLoginInput]::ShowWindowAsync($windowHandle, 9) | Out-Null
        [RiotLoginInput]::SetForegroundWindow($windowHandle) | Out-Null
        [System.Threading.Thread]::Sleep(400)
      }
      $windowRestoreRequested = $true
    }

    $processCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
      $riotProcess.Id
    )
    $processElements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $processCondition
    )
    $visibleEdits = @($processElements | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
      $_.Current.IsEnabled -and -not $_.Current.IsOffscreen
    })
    $usernameField = $visibleEdits |
      Where-Object { -not $_.Current.IsPassword -and $_.Current.Name -match '(?i)username|email' } |
      Select-Object -First 1
    $passwordField = $visibleEdits |
      Where-Object { $_.Current.IsPassword -or $_.Current.Name -match '(?i)password' } |
      Select-Object -First 1
    $staySignedIn = $processElements |
      Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox -and
        $_.Current.IsEnabled -and $_.Current.Name -match '(?i)stay signed in'
      } |
      Select-Object -First 1

    if ($ProbeOnly) {
      $hasUsername = [bool]$usernameField
      $hasPassword = [bool]$passwordField
      Write-Result $true "Helper started; visible=$($visibleEdits.Count); username=$hasUsername; password=$hasPassword; staySignedIn=$([bool]$staySignedIn)"
      exit 0
    }

    $loginButton = $processElements |
      Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and
        $_.Current.Name -match '(?i)^(sign\s*in|log\s*in|continue|submit|enter)$'
      } |
      Select-Object -First 1

    if (-not $usernameField -and $visibleEdits.Count -ge 2) {
      $usernameField = $visibleEdits |
        Where-Object { -not $_.Current.IsPassword -and $_.Current.Name -notmatch '(?i)password' } |
        Select-Object -First 1
    }
    if (-not $passwordField -and $visibleEdits.Count -ge 2) {
      $passwordField = $visibleEdits |
        Where-Object { $_.Current.IsPassword -or $_.Current.Name -match '(?i)password' } |
        Select-Object -First 1
      if (-not $passwordField) {
        $passwordField = $visibleEdits |
          Where-Object { -not $_.Current.IsPassword } |
          Sort-Object { $_.Current.BoundingRectangle.Left } |
          Select-Object -Last 1
      }
    }

    if ($usernameField -and $passwordField) {
      try {
        if ($usernameField -eq $passwordField) {
          throw 'The Riot login form exposed the same field twice; the account helper cannot safely distinguish username and password fields.'
        }

        $usernameValue = [System.Windows.Automation.ValuePattern]$usernameField.GetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern
        )
        $passwordValue = [System.Windows.Automation.ValuePattern]$passwordField.GetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern
        )

        if ($staySignedIn) {
          $toggle = [System.Windows.Automation.TogglePattern]$staySignedIn.GetCurrentPattern(
            [System.Windows.Automation.TogglePattern]::Pattern
          )
          if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {
            $toggle.Toggle()
          }
        }

        $usernameValue.SetValue([string]$payload.username)
        $passwordValue.SetValue([string]$payload.password)

        $windowHandle = [IntPtr]$riotProcess.MainWindowHandle
        [RiotLoginInput]::SetForegroundWindow($windowHandle) | Out-Null
        [System.Threading.Thread]::Sleep(150)
        if ([RiotLoginInput]::GetForegroundWindow() -ne $windowHandle) {
          throw 'Riot Client could not be brought to the foreground.'
        }

        $passwordBounds = $passwordField.Current.BoundingRectangle
        if ($passwordBounds.Width -le 0 -or $passwordBounds.Height -le 0) {
          throw 'Riot Client did not expose a usable password-field location.'
        }
        $clickX = [int]($passwordBounds.Left + ($passwordBounds.Width / 2))
        $clickY = [int]($passwordBounds.Top + ($passwordBounds.Height / 2))
        if (-not [RiotLoginInput]::SetCursorPos($clickX, $clickY)) {
          throw 'The password field could not be focused.'
        }
        [RiotLoginInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [RiotLoginInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        [System.Threading.Thread]::Sleep(100)

        $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($focusedElement -and $focusedElement.Current.ProcessId -ne $riotProcess.Id -or
            $focusedElement -and $focusedElement.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) {
          $focusedElement = $null
        }

        if ($loginButton) {
          try {
            $invokeButton = [System.Windows.Automation.InvokePattern]$loginButton.GetCurrentPattern(
              [System.Windows.Automation.InvokePattern]::Pattern
            )
            $invokeButton.Invoke()
          } catch {
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          }
        } else {
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        }

        Write-Result $true 'Credentials filled and the Riot sign-in form was submitted. Complete any 2FA prompt manually.'
        exit 0
      } catch {
        Write-Result $false $_.Exception.Message
        exit 1
      }
    }

    $signOutControl = $processElements |
      Where-Object {
        $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and
        $_.Current.Name -match '(?i)^\s*(sign out|log out|logout)\s*$' -and
        ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem -or
         $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button)
      } |
      Select-Object -First 1

    if ($signOutControl) {
      $controlType = $signOutControl.Current.ControlType
      $shouldInvoke = (-not $logoutRequested) -or
        ($logoutRequested -and -not $logoutConfirmationInvoked -and $controlType -eq [System.Windows.Automation.ControlType]::Button)
      if ($shouldInvoke) {
        try {
          $invoke = [System.Windows.Automation.InvokePattern]$signOutControl.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern
          )
          $invoke.Invoke()
          if (-not $logoutRequested) {
            $logoutRequested = $true
            $logoutConfirmationInvoked = $controlType -eq [System.Windows.Automation.ControlType]::Button
          } else {
            $logoutConfirmationInvoked = $true
          }
          $identityMenuExpanded = $false
          [System.Threading.Thread]::Sleep(500)
          continue
        } catch {
          Write-Result $false 'Riot exposed a Sign Out control that could not be activated. Sign out manually, then try again.'
          exit 1
        }
      }
    }

    if (-not $logoutRequested -and -not $identityMenuExpanded) {
      $identityMenu = $processElements |
        Where-Object { $_.Current.IsEnabled -and $_.Current.ClassName -eq 'identity-menu-disclosure' } |
        Select-Object -First 1
      if ($identityMenu) {
        try {
          $expand = $null
          if ($identityMenu.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$expand) -and
              $expand.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
            $expand.Expand()
            $identityMenuExpanded = $true
          }
        } catch {
          Write-Result $false 'The Riot account menu could not be opened. Sign out manually, then try again.'
          exit 1
        }
      }
    }

    [System.Threading.Thread]::Sleep(250)
  }

  if ($riotWindowFound -and $logoutRequested) {
    Write-Result $false 'Riot Client was signed out, but its Username and Password fields did not appear. Open the sign-in tab and try again.'
  } elseif ($riotWindowFound) {
    Write-Result $false 'Riot Client is open, but no accessible sign-in form or named Sign Out action was found.'
  } else {
    Write-Result $false 'Could not find a visible Riot Client window. Open it and try again.'
  }
  exit 1
} catch {
  Write-Result $false $_.Exception.Message
  exit 1
}
