---
title: Connected Apps
description: Connect AI assistants and other apps to your library, and disconnect them.
---

Connected apps can work with your library on your behalf. An AI assistant can add an article you mention and turn it into an audiobook, for example. You approve each app, and you can disconnect it at any time.

You need a registered account. Guests cannot approve apps.

## Connect an assistant

1. In the assistant, add a remote MCP server with your instance's address followed by `/api/mcp`, such as `https://reader.example/api/mcp`.
2. Your browser opens. Sign in if you are asked to.
3. Check the app's name, whether it is verified, and what it asks to do. Then choose **Allow access**.

Setup differs between assistants; see [MCP](../reference/mcp#connect-a-client). Other apps start the same approval from their own sign-in button.

Some apps show you a code instead of opening a browser. Enter it on your instance's device page, or follow the link the app gives you, and make sure the code matches. Only allow a code shown by a device you are using, never one someone sent you.

## Before you allow access

- **Verified as** names the domain that controls the app's identity. **Unverified app** means OpenReader can't confirm who made it, because apps choose their own names. Allow it only if you just started connecting it.
- A logo appears only beside **Verified as**. Every other app shows the first letter of its name, even if it declares a logo.
- **Returns to** is where your browser goes next.
- **Signed in as** is the account the app will use. Choose **Switch account** if it is the wrong one. The desktop app has one owner, so it skips this.

An app can ask to:

- read your documents, folders, voices and audiobooks,
- add, rename, move and delete your documents and folders,
- generate audiobooks using your speech providers and compute limits,
- keep access when you are away, until you disconnect it.

Apps can't see provider keys or administer the instance. Audio an app generates counts toward your limits and storage.

## Disconnect an app

Go to **Settings → Account → Connected apps** and choose **Disconnect**. It takes effect immediately.
