"""Render the public, plain-language MVP brief. Requires reportlab."""
from pathlib import Path
import re
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

root = Path(__file__).resolve().parents[1]
source = root / 'docs/ANC-Card-MVP-分享说明-2026-11-14.md'
output = root / 'output/pdf/ANC Card MVP 与未来计划 2026-11-14.pdf'
output.parent.mkdir(parents=True, exist_ok=True)
font = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
if font.exists():
    pdfmetrics.registerFont(TTFont('ANCText', str(font)))
else:
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    pdfmetrics.registerFontFamily('ANCText', normal='STSong-Light')
    font = None
font_name = 'ANCText' if font else 'STSong-Light'
navy = HexColor('#203e70')
styles = {
    'body': ParagraphStyle('body', fontName=font_name, fontSize=11, leading=18, textColor=HexColor('#263446'), wordWrap='CJK', spaceAfter=9),
    'h1': ParagraphStyle('h1', fontName=font_name, fontSize=22, leading=31, textColor=navy, wordWrap='CJK', spaceAfter=12),
    'h2': ParagraphStyle('h2', fontName=font_name, fontSize=15, leading=23, textColor=navy, wordWrap='CJK', spaceBefore=10, spaceAfter=9, keepWithNext=True),
}
story=[]
for page in source.read_text().split('<!-- page -->'):
    if story: story.append(PageBreak())
    for block in page.strip().split('\n\n'):
        if not block.strip(): continue
        kind='body'
        if block.startswith('# '): kind='h1';block=block[2:]
        elif block.startswith('## '): kind='h2';block=block[3:]
        # A shared font is used for Chinese; emphasize with color instead of faux bold.
        block=escape(block)
        block=re.sub(r'\*\*(.*?)\*\*',r'<font color="#203e70">\1</font>',block)
        block=block.replace('\n','<br/>')
        story.append(Paragraph(block,styles[kind]))

def frame(c, doc):
    w,h=doc.pagesize
    c.setStrokeColor(HexColor('#dce4ed'));c.line(42,h-49,w-42,h-49)
    c.setFont(font_name,9);c.setFillColor(navy)
    c.drawString(42,h-35,'NESTLINKER  /  ANC CARD')
    c.setFillColor(HexColor('#718096'));c.drawRightString(w-42,h-35,'原型实测与讨论稿 · 2026.11.14')
    c.drawString(42,27,'短录音闭环已验证 · 长会议、多人及外出使用仍待验证')
    c.drawRightString(w-42,27,str(doc.page))

doc=SimpleDocTemplate(str(output),pagesize=(595.28,841.89),rightMargin=44,leftMargin=44,topMargin=65,bottomMargin=53,
 title='ANC Card：今天跑通了什么，未来怎么做',author='NestLinker')
doc.build(story,onFirstPage=frame,onLaterPages=frame)
print(output)
