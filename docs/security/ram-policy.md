# Least-privilege RAM policy

The Worker requires **exactly four** Alibaba Cloud actions. This document specifies
the policy, states what it deliberately excludes, and gives the procedure for
issuing the credential without ever committing a value.

> **No credential, account ID, instance ID, or secret appears in this repository.**
> Values are supplied only through Wrangler secrets. Nothing here is a placeholder
> that could be mistaken for a real value.

## 1. The policy

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cdt:ListCdtInternetTraffic"],
      "Resource": ["*"]
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeInstances"],
      "Resource": ["*"]
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:StartInstance", "ecs:StopInstance"],
      "Resource": ["acs:ecs:*:*:instance/*"]
    }
  ]
}
```

Replace the ECS resource with the single managed instance when the owner confirms
its identifier at deployment time:

```json
"Resource": ["acs:ecs:<REGION_ID>:<ACCOUNT_ID>:instance/<ECS_INSTANCE_ID>"]
```

The identifier is supplied **at policy-creation time in the RAM console**, never in
this repository. `REGION_ID` and `ECS_INSTANCE_ID` are Worker bindings and are
likewise set outside the repository.

## 2. Why `Resource` is `*` for two statements

`cdt:ListCdtInternetTraffic` and `ecs:DescribeInstances` are read-only and are the
two calls whose scope cannot be narrowed safely in advance:

- **CDT** operates on the account's aggregated internet traffic. There is no
  per-instance resource to name, and the operation is undocumented (see the
  assumptions register), so constraining its resource shape would be guessing at
  an unverified contract. If the constraint were wrong the call would be denied
  and the Worker would fail closed — so the blast radius of `*` here is *reading*
  traffic for the account, which is the operation's entire purpose.
- **`DescribeInstances`** is a list operation. `DescribeInstances` with a
  resource-scoped ARN is what the `InstanceIds` parameter already achieves at
  request level; the action itself is read-only.

The two **mutating** actions are scoped to the instance ARN, because those are the
ones whose blast radius matters.

## 3. What is deliberately excluded

| Excluded | Why |
| --- | --- |
| `ecs:*`, `cdt:*`, or `*` | The Worker exercises exactly four actions. Granting more is authority it never uses, which is pure blast radius and fails the least-privilege requirement. |
| `ecs:RebootInstance` | **Explicit anti-requirement.** Community implementations rebooting an instance on an unrecognised status is a documented failure this project exists to avoid. |
| `ecs:StopInstances` / `ecs:StartInstances` (plural) | The batch forms operate on sets. The Worker manages exactly one instance. |
| `ecs:ModifyInstanceAttribute`, `DeleteInstance`, disk or snapshot actions | Destructive, and not needed to enforce a traffic threshold. |
| RAM, STS, billing, or account actions | The Worker never administers the account. |
| Any `cdt:*` write or service-activation action (`OpenCdtService`, `SwitchToCdt`, …) | Activation is an operator decision, not a runtime one. |

If a future change appears to need a fifth action, that is an architectural
change requiring owner approval — not a reason to widen this policy.

## 4. Creating the credential

Performed by the owner in the Alibaba Cloud console. **No value from this
procedure is ever copied into the repository, an issue, a chat message, a log, or
a commit.**

1. **RAM → Users → Create User.** Name it for its purpose (e.g. a name identifying
   the Worker). Enable **programmatic access only**; there is no console login.
2. **Attach the policy** from §1. Create a custom policy rather than attaching a
   system policy, because the system policies are broader than four actions.
3. **Create the AccessKey pair** for that user. Alibaba displays the secret once.
   Keep the console open until step 5 has succeeded.
4. **Scope the identity further if available.** If the account uses RAM
   permission boundaries or a tag-based condition, restricting to the single
   instance is preferable to `*`; record what was applied.
5. **Set the three required Worker secrets** (values pasted only into the shell prompt):

   ```
   npx wrangler secret put ALIYUN_ACCESS_KEY_ID
   npx wrangler secret put ALIYUN_ACCESS_KEY_SECRET
   npx wrangler secret put ADMIN_TOKEN
   ```

   Each command prompts for the value. It is not echoed to the terminal, not
   stored in shell history, and not written to any file.

   Webhook reporting is optional. When enabled, set `WEBHOOK_URL` to an absolute
   HTTPS endpoint. Set `WEBHOOK_TOKEN` only when bearer auth is needed; a token
   without the URL is a Worker config error.

6. **Verify by absence, not by printing.** Do not run any command that echoes a
   secret to confirm it was set. Confirm through the deployment (§ the deployment
   document), which fails loudly when a required secret is missing. RELEASE
   requires the two Alibaba credentials and `ADMIN_TOKEN`; webhook secrets are
   optional.

## 5. Verification the policy is minimal

`grep` this file for wildcard actions and confirm there are none:

```sh
rg -n '"(ecs|cdt):\*"|"\*"' docs/security/ram-policy.md
```

The only `*` values permitted are the two `Resource` fields in §1, which are
documented and justified above. No wildcard **action** appears anywhere.

A repository-wide scan for credential-shaped values must also return nothing:

```sh
rg -n 'LTAI[0-9A-Za-z]{8,}' .
```

## 6. References

- PLAN §8 (security model), §11 (risks).
- SPEC §2.1 (secret bindings).
- The assumptions register, for the CDT operation's undocumented status which
  justifies the `*` resource on that first statement.
