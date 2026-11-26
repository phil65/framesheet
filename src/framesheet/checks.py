"""Static (source-level) checks, ported from the svg-animation skill's ``verify_svg.py``.

Every check returns :class:`~framesheet.models.Finding` objects with ``check="static"``.
Render-time checks (geometry over time) live in :mod:`framesheet.analysis`.
"""

from collections import Counter
from html.parser import HTMLParser
import re
import xml.etree.ElementTree as ET

from framesheet.models import Finding, Severity


SVG_NS = "http://www.w3.org/2000/svg"
LARGE_SVG_KB = 100
_URL_REF = re.compile(r"url\(\s*['\"]?#([^)'\"]+)['\"]?\s*\)")
_POSITIVE_CLOCK = re.compile(r"^([0-9]*\.?[0-9]+)(ms|s)?$")
_KEYFRAMES = re.compile(r"@keyframes[^{]*\{((?:[^{}]*\{[^}]*\})*)[^}]*\}", re.S)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _finding(severity: Severity, code: str, message: str, element: str | None = None) -> Finding:
    return Finding(severity=severity, code=code, message=message, check="static", element=element)


def _label(tag: str, attrib: dict[str, str]) -> str:
    el_id = attrib.get("id")
    return f"{tag}#{el_id}" if el_id else tag


def check_css(css: str, *, svg: bool) -> list[Finding]:
    """Checks on the concatenated text of all ``<style>`` blocks."""
    out: list[Finding] = []
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    if not css.strip():
        return out
    if re.search(r"@import\s+url\(|https?://", css):
        out.append(
            _finding(
                "warning",
                "css-external",
                "CSS references an external URL/font (blocked when the SVG is used as <img>).",
            )
        )
    animated = re.search(r"\banimation(-name)?\s*:", css) is not None
    if animated and "prefers-reduced-motion" not in css:
        out.append(
            _finding(
                "warning",
                "no-reduced-motion",
                "CSS animations present without @media (prefers-reduced-motion: reduce).",
            )
        )
    if svg and "transform-box" not in css:
        has_transform = re.search(r"\btransform\s*:", css) is not None
        if has_transform and "transform-origin" in css:
            out.append(
                _finding(
                    "warning",
                    "transform-origin-without-box",
                    "CSS transform-origin used without transform-box: fill-box; may pivot "
                    "unexpectedly across SVG renderers.",
                )
            )
        elif animated and _keyframes_transform(css):
            out.append(
                _finding(
                    "warning",
                    "transform-without-box",
                    "CSS @keyframes animate transform/rotate/scale but no transform-box is set; "
                    "SVG elements then rotate/scale around the SVG origin (0,0). Add "
                    "transform-box: fill-box; transform-origin: center.",
                )
            )
    return out


def _keyframes_transform(css: str) -> bool:
    return any(
        re.search(r"\b(transform|rotate|scale|translate)\s*:", block)
        for block in _KEYFRAMES.findall(css)
    )


def check_svg_source(raw: str) -> list[Finding]:
    """Static checks for a standalone SVG document (portability, references, pitfalls)."""
    out: list[Finding] = []
    size_kb = len(raw.encode()) / 1024
    if size_kb > LARGE_SVG_KB:
        out.append(
            _finding(
                "warning",
                "large-file",
                f"Large SVG ({size_kb:.1f} KB); consider simplifying paths or defs.",
            )
        )
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        return [*out, _finding("error", "malformed-xml", f"Malformed XML: {exc}")]

    if _local(root.tag) != "svg":
        out.append(
            _finding("error", "not-svg", f"Root element is <{_local(root.tag)}>, expected <svg>.")
        )
    if not root.tag.startswith(f"{{{SVG_NS}}}"):
        out.append(
            _finding("error", "missing-xmlns", 'Missing xmlns="http://www.w3.org/2000/svg".')
        )
    if not root.attrib.get("viewBox"):
        out.append(_finding("error", "missing-viewbox", "Missing viewBox attribute on <svg>."))
    has_title = any(_local(el.tag) == "title" for el in root.iter())
    if not (root.attrib.get("aria-label") or has_title):
        out.append(
            _finding("warning", "missing-title", "Missing aria-label or <title> for accessibility.")
        )

    ids: Counter[str] = Counter()
    refs: set[str] = set()
    css_blocks: list[str] = []
    for el in root.iter():
        tag = _local(el.tag)
        if el_id := el.attrib.get("id"):
            ids[el_id] += 1
        if tag == "script":
            out.append(
                _finding(
                    "error",
                    "script",
                    "Contains <script>, which is stripped by GitHub and blocked in <img>.",
                )
            )
        if tag == "foreignObject":
            out.append(
                _finding(
                    "warning",
                    "foreign-object",
                    "Contains <foreignObject>, which breaks in many <img>/SVG viewers.",
                )
            )
        for name, value in el.attrib.items():
            attr = _local(name)
            if attr.startswith("on"):
                out.append(
                    _finding(
                        "error",
                        "event-handler",
                        f"Inline event handler '{attr}' on <{tag}> (stripped in <img>).",
                        _label(tag, el.attrib),
                    )
                )
            if re.search(r"https?://", value) and attr != "xmlns":
                out.append(
                    _finding(
                        "warning",
                        "external-url",
                        f"External URL in {attr}='{value}' on <{tag}> (blocked in GitHub <img>).",
                        _label(tag, el.attrib),
                    )
                )
            refs.update(_URL_REF.findall(value))
            if attr == "href" and value.startswith("#"):
                refs.add(value[1:])
        if tag == "animateMotion":
            begin = el.attrib.get("begin", "").strip()
            match = _POSITIVE_CLOCK.match(begin)
            if match and float(match.group(1)) > 0:
                out.append(
                    _finding(
                        "warning",
                        "positive-begin",
                        f"<animateMotion begin='{begin}'> uses a positive delay; the parent "
                        "shape may park at (0,0) before start. Use a negative begin offset.",
                    )
                )
        if tag == "style" and el.text:
            css_blocks.append(el.text)
        if style := el.attrib.get("style"):
            refs.update(_URL_REF.findall(style))

    css = "\n".join(css_blocks)
    refs.update(_URL_REF.findall(css))
    out.extend(_id_findings(ids, refs))
    out.extend(check_css(css, svg=True))
    return out


def _id_findings(ids: Counter[str], refs: set[str]) -> list[Finding]:
    out = [
        _finding("error", "duplicate-id", f"Duplicate id='{el_id}' ({count} occurrences).")
        for el_id, count in ids.items()
        if count > 1
    ]
    out.extend(
        _finding("error", "broken-ref", f"Broken internal reference '#{ref}' (no matching id).")
        for ref in sorted(refs)
        if ref not in ids
    )
    return out


class _HTMLCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: Counter[str] = Counter()
        self.refs: set[str] = set()
        self.css: list[str] = []
        self._in_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._in_style = tag == "style"
        for name, value in attrs:
            if value is None:
                continue
            if name == "id":
                self.ids[value] += 1
            self.refs.update(_URL_REF.findall(value))
            # Only SVG-style fragment references; HTML <a href="#top"> is navigation.
            if name in {"xlink:href", "href"} and value.startswith("#") and tag in _SVG_REF_TAGS:
                self.refs.add(value[1:])

    def handle_endtag(self, tag: str) -> None:
        if tag == "style":
            self._in_style = False

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self.css.append(data)


_SVG_REF_TAGS = {"use", "mpath", "textpath", "lineargradient", "radialgradient", "pattern"}


def check_html_source(raw: str) -> list[Finding]:
    """Static checks for an HTML document: ids, internal references, reduced motion."""
    parser = _HTMLCollector()
    parser.feed(raw)
    css = "\n".join(parser.css)
    refs = parser.refs | set(_URL_REF.findall(css))
    return [*_id_findings(parser.ids, refs), *check_css(css, svg="<svg" in raw.lower())]
