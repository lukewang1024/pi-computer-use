using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

public class PressClickFixture : Form {
  static string audit;
  int count, noops, left, right, doubles, menuCount, modalCount;
  Label summary;
  Button removable;
  void Record(string name, string value) {
    File.AppendAllText(audit, DateTime.UtcNow.ToString("o") + "\t" + name + "\t" + value + Environment.NewLine);
    summary.Text = "Counts: button=" + count + " noop=" + noops + " left=" + left + " right=" + right + " double=" + doubles + " menu=" + menuCount + " modal=" + modalCount;
  }
  T Place<T>(T c, string name, int x, int y, int w, int h) where T : Control {
    c.Text=name; c.AccessibleName=name; c.Name=name.Replace(" ", ""); c.SetBounds(x,y,w,h); Controls.Add(c); return c;
  }
  void OpenModal() {
    modalCount++; Record("modal_open", modalCount.ToString());
    using (Form d = new Form()) {
      d.Text="CU P0 Modal"; d.Name="CU-P0-Modal"; d.Size=new Size(400,220); d.StartPosition=FormStartPosition.CenterParent;
      d.FormBorderStyle=FormBorderStyle.FixedDialog; d.MaximizeBox=false; d.MinimizeBox=false;
      TextBox edit=new TextBox(); edit.Name="ModalInput"; edit.AccessibleName="Modal input"; edit.SetBounds(20,25,340,28); d.Controls.Add(edit);
      Button ok=new Button(); ok.Text="Confirm modal"; ok.AccessibleName=ok.Text; ok.SetBounds(30,95,145,35);
      ok.Click += delegate {Record("modal_confirm",edit.Text);d.DialogResult=DialogResult.OK;d.Close();};d.Controls.Add(ok);
      Button cancel=new Button();cancel.Text="Cancel modal";cancel.AccessibleName=cancel.Text;cancel.SetBounds(195,95,145,35);
      cancel.Click += delegate {Record("modal_cancel",edit.Text);d.DialogResult=DialogResult.Cancel;d.Close();};d.Controls.Add(cancel);
      d.CancelButton=cancel; d.ShowDialog(this);
    }
    Record("modal_returned",modalCount.ToString());
  }
  public PressClickFixture(string path) {
    audit=path; if(File.Exists(audit))throw new Exception("Audit already exists");
    Text="CU P0 Press Click 1852";Name="CU-P0-PressClick";Size=new Size(1020,760);StartPosition=FormStartPosition.CenterScreen;
    summary=Place(new Label(),"Counts: initial",20,630,960,50);
    MenuStrip menu=new MenuStrip();
    ToolStripMenuItem file=new ToolStripMenuItem("Fixture menu");
    ToolStripMenuItem run=new ToolStripMenuItem("Run menu action");run.Click+=delegate{menuCount++;Record("menu",menuCount.ToString());};file.DropDownItems.Add(run);
    ToolStripMenuItem modalMenu=new ToolStripMenuItem("Open modal via menu");modalMenu.Click+=delegate{OpenModal();};file.DropDownItems.Add(modalMenu);
    menu.Items.Add(file);Controls.Add(menu);MainMenuStrip=menu;
    Place(new Button(),"Count button",20,50,170,40).Click+=delegate{count++;Record("button",count.ToString());};
    Place(new Button(),"No-op button",210,50,170,40).Click+=delegate{noops++;Record("noop",noops.ToString());};
    Place(new Button(),"Open modal",400,50,170,40).Click+=delegate{OpenModal();};
    Button disabled=Place(new Button(),"Disabled button",590,50,170,40);disabled.Enabled=false;disabled.Click+=delegate{Record("DISABLED_CLICK","unexpected");};
    CheckBox check=Place(new CheckBox(),"Enable feature",20,115,180,30);check.CheckedChanged+=delegate{Record("checkbox",check.Checked.ToString());};
    RadioButton a=Place(new RadioButton(),"Choice A",220,115,130,30);RadioButton b=Place(new RadioButton(),"Choice B",360,115,130,30);
    a.Checked=true;a.CheckedChanged+=delegate{if(a.Checked)Record("radio","A");};b.CheckedChanged+=delegate{if(b.Checked)Record("radio","B");};
    ComboBox combo=Place(new ComboBox(),"Choose option",530,115,200,30);combo.DropDownStyle=ComboBoxStyle.DropDownList;combo.Items.AddRange(new object[]{"Option One","Option Two"});combo.SelectedIndex=0;
    combo.SelectedIndexChanged+=delegate{Record("combo",combo.SelectedItem.ToString());};
    TabControl tabs=Place(new TabControl(),"Fixture tabs",20,175,450,180);tabs.TabPages.Add("General");tabs.TabPages.Add("Advanced");
    tabs.TabPages[0].Controls.Add(new Label(){Text="General page content",AutoSize=true});tabs.TabPages[1].Controls.Add(new Label(){Text="Advanced page content",AutoSize=true});
    tabs.SelectedIndexChanged+=delegate{Record("tab",tabs.SelectedTab.Text);};
    TreeView tree=Place(new TreeView(),"Fixture tree",500,175,450,180);TreeNode folder=tree.Nodes.Add("Folder node");folder.Nodes.Add("Child node");
    tree.AfterExpand+=delegate{Record("tree","expanded");};tree.AfterCollapse+=delegate{Record("tree","collapsed");};
    TextBox editor=Place(new TextBox(),"Editor input",20,390,450,30);editor.Text="initial";editor.GotFocus+=delegate{Record("editor_focus","true");};editor.TextChanged+=delegate{Record("editor_text",editor.Text);};
    Panel pad=Place(new Panel(),"Pointer pad",500,390,450,180);pad.BackColor=Color.LightBlue;pad.AccessibleRole=AccessibleRole.Pane;
    pad.Paint+=delegate(object sender,PaintEventArgs e){e.Graphics.DrawString("Pointer pad: left / double / right click",Font,Brushes.Black,new PointF(20,20));};
    pad.MouseClick+=delegate(object sender,MouseEventArgs e){if(e.Button==MouseButtons.Left){left++;Record("left",left.ToString());}else if(e.Button==MouseButtons.Right){right++;Record("right",right.ToString());}};
    pad.MouseDoubleClick+=delegate{doubles++;Record("double",doubles.ToString());};
    ContextMenuStrip context=new ContextMenuStrip();ToolStripMenuItem contextAction=new ToolStripMenuItem("Context action");contextAction.Click+=delegate{menuCount++;Record("context",menuCount.ToString());};context.Items.Add(contextAction);pad.ContextMenuStrip=context;
    removable=Place(new Button(),"Removable button",20,455,200,40);removable.Click+=delegate{Record("REMOVED_CLICK","unexpected");};
    Place(new Button(),"Remove target",250,455,200,40).Click+=delegate{removable.Dispose();Record("removed","true");};
    Place(new Button(),"Close fixture",20,530,200,40).Click+=delegate{Record("close","true");Close();};
    Shown+=delegate{Record("ready","true");};
  }
  [STAThread] public static void Main(string[] args) {
    if(args.Length!=1)throw new Exception("Audit path required");
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new PressClickFixture(args[0]));
  }
}
