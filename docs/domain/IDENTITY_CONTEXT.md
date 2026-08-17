# Tianxing K12 Identity Context

This context defines the Release 1 terms for internal account disable and its
provider-side reconciliation. It separates local authorization facts from
external provider effects.

## Language

**Account Disable**:
The Release 1 transition of an active internal User to `disabled`; it
invalidates the User's local application sessions immediately.
_Avoid_: provider revoke, suspension

**Cognito Revoke Effect**:
The provider-session revoke work caused by an Account Disable; it is not the
authority for application access.
_Avoid_: account disable, login denial

**Reconciliation Attempt**:
One leased delivery attempt for a Cognito Revoke Effect, with a bounded
outcome recorded against that effect.
_Avoid_: account disable, session revoke

**Revoke Receipt**:
The durable non-PII terminal outcome record for one Cognito Revoke Effect.
_Avoid_: notification receipt, account status
