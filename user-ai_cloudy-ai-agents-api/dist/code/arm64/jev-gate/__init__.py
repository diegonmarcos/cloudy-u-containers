"""hermes plugin adapter for jev-gate (#764, #765). All logic lives in jev_gate.py beside this file.

#765: a pre_llm_call hook returns {"context": ...} with the code-graph context Jev routed the turn's
user message to; hermes appends it to that user message (agent/turn_context.py), never to the system
prompt, and runs the hook under plugins.hook_callback_timeout, failing open.

Registered as llm_request middleware: hermes calls it on every API call with the provider kwargs
as `request`; returning {"request": ...} replaces them, returning None leaves them untouched
(hermes_cli/middleware.py). jev_gate is loaded by path rather than by package-relative import
because hermes imports plugin directories under its own module names.
"""
import importlib.util
import logging
import os

_log = logging.getLogger("jev-gate")


def _gate():
    spec = importlib.util.spec_from_file_location(
        "jev_gate", os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev_gate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def register(ctx):
    gate = _gate()
    cfg = gate.load_config()
    _register_code_context(ctx, gate, cfg)
    if not gate.use_cfg(cfg, "hermes_tool_select"):
        _log.info("jev-gate: hermes_tool_select disabled in jev-gate.json")
        return
    if not callable(getattr(ctx, "register_middleware", None)):
        _log.warning("jev-gate: this hermes has no register_middleware; tool selection stays off")
        return

    def narrow_tools(request=None, api_call_count=None, api_mode=None, **_):
        out = gate.select_tools(request, cfg, api_call_count=api_call_count, api_mode=api_mode)
        return None if out is None else {"request": out, "source": "jev-gate", "reason": "tool selection"}

    ctx.register_middleware("llm_request", narrow_tools)


def _register_code_context(ctx, gate, cfg):
    if not gate.use_cfg(cfg, "code_context"):
        return
    if not callable(getattr(ctx, "register_hook", None)):
        _log.warning("jev-gate: this hermes has no register_hook; code-graph context stays off")
        return

    def code_context(session_id="", user_message=None, **_):
        prompt = gate._last_user_text([{"role": "user", "content": user_message}])
        text = gate.route_context("hermes", prompt, session_id, os.getcwd(), cfg)
        return {"context": text} if text else None

    ctx.register_hook("pre_llm_call", code_context)
